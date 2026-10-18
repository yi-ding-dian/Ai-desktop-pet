"""会话生命周期管理（P3：SQLite 持久化 + 进程内多轮历史）。

- 会话表：创建 / 恢复 / 查询（进程内缓存，单事件循环访问，无锁需求）；
- 对话历史：内存 deque 保留最近 N 轮（注入 LLM 上下文），同时**增量落库**
  （§6.2 messages 表）——进程重启后由 :class:`HistoryStore` 恢复，历史不丢
  （P1 欠账"重启后会话还在"在 P3 兑现）；
- 持久化失败（磁盘/权限等）：记日志、不阻断对话——对话内存态继续可用。

每次会话对象还持有「记忆提取水位」``last_extracted_at``（内存态，不落库）：
memory_service 以此判断"空闲且自上次提取后无新消息"才触发提取。
"""

from __future__ import annotations

import time
import uuid
from collections import deque
from typing import TYPE_CHECKING

from loguru import logger

from backend.modules.llm.provider import ChatMessage

if TYPE_CHECKING:  # 仅类型注解（chat 域公开类；避免运行时强依赖，便于无库测试）
    from backend.modules.chat.history import HistoryStore

HISTORY_MAX_TURNS = 10  # 上下文注入的"最近 N 轮"上限（§4.2）
_HISTORY_MAX_MESSAGES = HISTORY_MAX_TURNS * 2  # user + assistant 各一条 / 轮


def _now_ms() -> int:
    return int(time.time() * 1000)


class Session:
    """一个会话（含内存态对话历史 + 落库句柄）。"""

    def __init__(
        self,
        id: str,
        created_at: int,
        last_active_at: int,
        *,
        store: HistoryStore | None = None,
        history: list[ChatMessage] | None = None,
        last_extracted_at: int = 0,
    ) -> None:
        """
        - ``store``：历史落库句柄；None 时纯内存（单测/未装配场景）；
        - ``history``：恢复会话时预装载的最近消息（不会重复写库）；
        - ``last_extracted_at``：记忆提取水位（毫秒；memory_service 维护）。
        """
        self.id = id
        self.created_at = created_at
        self.last_active_at = last_active_at
        self.last_extracted_at = last_extracted_at
        self._store = store
        # 最近 N 轮消息（超出上限自动淘汰最旧）；deque 左端为最旧消息
        self.history: deque[ChatMessage] = deque(
            history or [], maxlen=_HISTORY_MAX_MESSAGES
        )

    def touch(self) -> None:
        """更新活跃时间。"""
        self.last_active_at = _now_ms()

    def append_message(
        self,
        role: str,
        content: str,
        *,
        emotion: str | None = None,
        created_at: int | None = None,
    ) -> int | None:
        """追加一条对话消息（role: user / assistant / system）。

        - 内存态立即生效（上下文组装用）；
        - 同时增量落库（若装配了 store），返回 DB 行 id（工作模式删除用）；
          写库失败不打断对话，只记日志并返回 None；
        - 顺带更新活跃时间——memory_service 的"会话空闲"判定依赖它。
        """
        self.history.append(ChatMessage(role=role, content=content))
        self.touch()
        if self._store is not None:
            try:
                return self._store.append_message(
                    self.id,
                    role,
                    content,
                    emotion=emotion,
                    created_at=created_at,
                )
            except Exception:  # sqlite 异常不应影响对话主链路
                logger.exception("消息落库失败 session={} role={}", self.id, role)
        return None

    def recent_messages(self) -> list[ChatMessage]:
        """取最近 N 轮消息（时间顺序，注入 LLM 上下文用）。"""
        return list(self.history)

    def reload_history(self) -> None:
        """从 SQLite 重建注入 LLM 的内存上下文（删除单条消息后用）。

        不重建的话，工作窗虽然删掉了消息，模型下一轮仍会在上下文里看到它。
        deque 上限与正常窗口一致（最近 N 轮）。
        """
        if self._store is None:
            return
        try:
            rows = self._store.recent_messages(self.id, limit=_HISTORY_MAX_MESSAGES)
        except Exception:  # 读库失败：保留现有上下文，不影响对话
            logger.exception("会话上下文重载失败 session={}", self.id)
            return
        self.history = deque(
            (ChatMessage(role=row["role"], content=row["content"]) for row in rows),
            maxlen=_HISTORY_MAX_MESSAGES,
        )

    def drop_context(self) -> int:
        """丢弃**内存上下文**（文件分析超预算时用）：返回清掉的消息条数。

        只清 ``history`` 这个"注入 LLM 的窗口"：数据库里的消息不删（load_history
        仍可回看），当前轮随后会 append 进来，后续轮只从当前文件这一轮往后继续。
        """
        dropped = len(self.history)
        self.history.clear()
        return dropped


class SessionManager:
    """会话表：创建 / 恢复 / 查询。"""

    def __init__(self, store: HistoryStore | None = None) -> None:
        """
        ``store``：HistoryStore（SQLite）。装配后：
        - 新会话即时落库 sessions 表；
        - ``start()`` 遇到库中已有 id 时**恢复**该会话（装载最近历史，
          供重启后 load_history / 继续对话使用）。
        """
        self._sessions: dict[str, Session] = {}
        self._store = store

    def start(self, session_id: str | None = None) -> Session:
        """开启（或复用/恢复已有）会话；session_id 缺省时自动生成。"""
        if session_id:
            session = self._sessions.get(session_id)
            if session is not None:
                session.touch()
                return session
            restored = self._restore(session_id)
            if restored is not None:
                self._sessions[session_id] = restored
                return restored

        sid = session_id or uuid.uuid4().hex
        now = _now_ms()
        session = Session(id=sid, created_at=now, last_active_at=now, store=self._store)
        self._sessions[sid] = session
        if self._store is not None:
            try:
                self._store.create_session(sid, created_at=now)
            except Exception:
                logger.exception("会话落库失败 session={}", sid)
        return session

    def get(self, session_id: str) -> Session | None:
        """按 id 查询会话（仅进程内缓存；不含"库中有但未装载"的会话）。"""
        return self._sessions.get(session_id)

    def all_sessions(self) -> list[Session]:
        """全部已装载会话（记忆提取的空闲扫描用）。"""
        return list(self._sessions.values())

    def count(self) -> int:
        """会话数（测试/调试用）。"""
        return len(self._sessions)

    # ---------- 内部 ----------

    def _restore(self, session_id: str) -> Session | None:
        """从库恢复会话（重启后首次被访问时装载）；库中不存在返回 None。"""
        if self._store is None or not self._store.session_exists(session_id):
            return None
        meta = self._store.get_session(session_id)
        rows = self._store.recent_messages(session_id, limit=_HISTORY_MAX_MESSAGES)
        last_at = self._store.last_message_at(session_id)
        history = [ChatMessage(role=row["role"], content=row["content"]) for row in rows]
        now = _now_ms()
        session = Session(
            id=session_id,
            created_at=int(meta["created_at"]) if meta else (last_at or now),
            # 活跃时间取"最后一条消息时间"而非恢复到内存的时刻：
            # 重启后空闲判定沿用真实时间线（不会重算 5 分钟窗口）
            last_active_at=last_at or now,
            store=self._store,
            history=history,
            # 水位推到"最后一条消息时间"：重启后不会对旧内容重复触发记忆提取
            last_extracted_at=last_at or 0,
        )
        logger.info("会话恢复 session={} 历史 {} 条", session_id, len(history))
        return session
