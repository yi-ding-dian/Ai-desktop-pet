"""会话生命周期管理（P1：内存态多轮历史）。

- 会话表：创建 / 查询 / 续期（进程内，单事件循环访问，无锁需求）；
- 对话历史：每个会话保留最近 N 轮（user + assistant 成对计一轮），
  供 chat_pipeline 组装上下文——SQLite 落库（§6.2 messages 表）为后续步骤，
  届时由本模块统一承担会话数据的所有权（高内聚原则）。
"""

from __future__ import annotations

import time
import uuid
from collections import deque
from dataclasses import dataclass, field

from backend.modules.llm.provider import ChatMessage

HISTORY_MAX_TURNS = 10  # 上下文注入的"最近 N 轮"上限（§4.2）
_HISTORY_MAX_MESSAGES = HISTORY_MAX_TURNS * 2  # user + assistant 各一条 / 轮


def _now_ms() -> int:
    return int(time.time() * 1000)


@dataclass
class Session:
    """一个会话（含内存态对话历史）。"""

    id: str
    created_at: int
    last_active_at: int
    # 最近 N 轮消息（超出上限自动淘汰最旧）；deque 左端为最旧消息
    history: deque[ChatMessage] = field(
        default_factory=lambda: deque(maxlen=_HISTORY_MAX_MESSAGES)
    )

    def touch(self) -> None:
        """更新活跃时间。"""
        self.last_active_at = _now_ms()

    def append_message(self, role: str, content: str) -> None:
        """追加一条对话消息（role: user / assistant / system）。"""
        self.history.append(ChatMessage(role=role, content=content))

    def recent_messages(self) -> list[ChatMessage]:
        """取最近 N 轮消息（时间顺序，注入 LLM 上下文用）。"""
        return list(self.history)


class SessionManager:
    """内存态会话表：创建 / 查询 / 续期。"""

    def __init__(self) -> None:
        self._sessions: dict[str, Session] = {}

    def start(self, session_id: str | None = None) -> Session:
        """开启（或复用已有）会话；session_id 缺省时自动生成。"""
        if session_id:
            session = self._sessions.get(session_id)
            if session is not None:
                session.touch()
                return session
        sid = session_id or uuid.uuid4().hex
        session = Session(id=sid, created_at=_now_ms(), last_active_at=_now_ms())
        self._sessions[sid] = session
        return session

    def get(self, session_id: str) -> Session | None:
        """按 id 查询会话。"""
        return self._sessions.get(session_id)

    def count(self) -> int:
        """会话数（测试/调试用）。"""
        return len(self._sessions)
