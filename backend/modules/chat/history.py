"""会话历史读写（SQLite，§4.2 history.py / §6.2 sessions + messages 表）。

职责边界：
- 本模块只做 **sessions / messages** 两张表的读写（chat 域内聚）；
- 进程内使用：单事件循环同步短语句，连接由 shared.db.connect_db 提供；
- memories / profile 表由 memory 域（modules/memory/）负责，本文件不触碰。

时间戳统一为**毫秒**（与前端 Date.now() / protocol.ts 一致）。
"""

from __future__ import annotations

import re
import sqlite3
import time
from typing import Any

#: load_history 单次返回条数上限（防止前端传超大 limit 拖库）
MAX_HISTORY_LIMIT = 200
#: 对话列表单次返回上限
MAX_CONVERSATION_LIMIT = 200
#: 自动标题的最大字数（超出截断）
MAX_TITLE_CHARS = 30
#: 固定的宠物会话 id（单一会话，置顶、不可改名/删除，2026-10-24）
PET_SESSION_ID = "pet-primary"
PET_SESSION_TITLE = "宠物会话"


def _now_ms() -> int:
    return int(time.time() * 1000)


def title_from_text(text: str) -> str:
    """从首条用户消息生成会话标题：跳过附件行，压成一行并截断。"""
    lines = [line.strip() for line in (text or "").splitlines() if line.strip()]
    content = next((line for line in lines if not line.startswith("📎")), lines[0] if lines else "")
    content = re.sub(r"\s+", " ", content).strip()
    if not content:
        return ""
    return content if len(content) <= MAX_TITLE_CHARS else f"{content[:MAX_TITLE_CHARS]}…"


class HistoryStore:
    """sessions / messages 表的轻量读写封装。"""

    def __init__(self, conn: sqlite3.Connection) -> None:
        self._conn = conn

    # ---------- sessions ----------

    def create_session(self, session_id: str, *, created_at: int | None = None) -> None:
        """登记会话；已存在时忽略（幂等，容忍并发/重复调用）。"""
        self._conn.execute(
            "INSERT OR IGNORE INTO sessions (id, created_at) VALUES (?, ?)",
            (session_id, created_at if created_at is not None else _now_ms()),
        )

    def session_exists(self, session_id: str) -> bool:
        """会话是否已入库（重启后恢复会话的判定依据）。"""
        row = self._conn.execute(
            "SELECT 1 FROM sessions WHERE id = ? LIMIT 1", (session_id,)
        ).fetchone()
        return row is not None

    def get_session(self, session_id: str) -> dict[str, Any] | None:
        """读会话元数据（id/title/created_at/ended_at）；不存在返回 None。"""
        row = self._conn.execute(
            "SELECT id, title, created_at, ended_at FROM sessions WHERE id = ?",
            (session_id,),
        ).fetchone()
        return dict(row) if row is not None else None

    def end_session(self, session_id: str, *, ended_at: int | None = None) -> None:
        """标记会话结束（§6.2 sessions.ended_at；当前无调用方，供后续"结束会话"用例）。"""
        self._conn.execute(
            "UPDATE sessions SET ended_at = ? WHERE id = ?",
            (ended_at if ended_at is not None else _now_ms(), session_id),
        )

    def list_conversations(self, limit: int = 100) -> list[dict[str, Any]]:
        """对话列表：只含有消息的会话，按最后一条消息时间倒序。

        - 标题优先取 ``sessions.title``；没有则用首条消息内容兜底；
        - 空会话（设置窗/探测连接产生）一律不返回。
        """
        limit = max(1, min(int(limit), MAX_CONVERSATION_LIMIT))
        rows = self._conn.execute(
            """
            SELECT s.id AS id,
                   s.created_at AS created_at,
                   COALESCE(
                       NULLIF(s.title, ''),
                       (SELECT content FROM messages WHERE session_id = s.id ORDER BY id LIMIT 1),
                       '新对话'
                   ) AS title,
                   MAX(m.created_at) AS updated_at,
                   COUNT(m.id) AS message_count
            FROM sessions s
            JOIN messages m ON m.session_id = s.id
            GROUP BY s.id
            ORDER BY updated_at DESC
            LIMIT ?
            """,
            (limit,),
        ).fetchall()
        items: list[dict[str, Any]] = []
        for row in rows:
            item = dict(row)
            item["title"] = title_from_text(str(item.get("title") or "")) or "新对话"
            item["kind"] = "pet" if item["id"] == PET_SESSION_ID else "chat"
            items.append(item)

        # 宠物会话是固定入口：没有消息也要在列表里（置顶）
        pet = next((item for item in items if item["kind"] == "pet"), None)
        if pet is None:
            self.ensure_pet_session()
            meta = self.get_session(PET_SESSION_ID) or {}
            created = int(meta.get("created_at") or _now_ms())
            pet = {
                "id": PET_SESSION_ID,
                "title": PET_SESSION_TITLE,
                "created_at": created,
                "updated_at": self.last_message_at(PET_SESSION_ID) or created,
                "message_count": self.message_count(PET_SESSION_ID),
                "kind": "pet",
            }
        pet["title"] = PET_SESSION_TITLE
        items = [pet] + [item for item in items if item["kind"] != "pet"]
        return items

    def ensure_pet_session(self) -> None:
        """确保固定的宠物会话存在，并把标题固定成「宠物会话」。"""
        self.create_session(PET_SESSION_ID)
        self._conn.execute(
            "UPDATE sessions SET title = ? WHERE id = ? AND (title IS NULL OR title = '')",
            (PET_SESSION_TITLE, PET_SESSION_ID),
        )

    def rename_session(self, session_id: str, title: str) -> bool:
        """改会话标题；宠物会话固定标题，拒绝改名。"""
        if session_id == PET_SESSION_ID:
            return False
        text = title_from_text(title)
        if not text:
            return False
        cursor = self._conn.execute(
            "UPDATE sessions SET title = ? WHERE id = ?", (text, session_id)
        )
        return cursor.rowcount > 0

    def delete_session(self, session_id: str) -> bool:
        """删除会话及其全部消息；宠物会话不可删除。"""
        if session_id == PET_SESSION_ID:
            return False
        self._conn.execute("DELETE FROM messages WHERE session_id = ?", (session_id,))
        cursor = self._conn.execute("DELETE FROM sessions WHERE id = ?", (session_id,))
        return cursor.rowcount > 0

    # ---------- messages ----------

    def append_message(
        self,
        session_id: str,
        role: str,
        content: str,
        *,
        emotion: str | None = None,
        created_at: int | None = None,
    ) -> int:
        """追加一条消息，返回自增 id。

        注意：调用方应保证 session_id 已 create_session（外键约束），
        但为健壮起见这里先做一次兜底 INSERT OR IGNORE。
        """
        self.create_session(session_id)
        cursor = self._conn.execute(
            "INSERT INTO messages (session_id, role, content, emotion, created_at) "
            "VALUES (?, ?, ?, ?, ?)",
            (
                session_id,
                role,
                content,
                emotion,
                created_at if created_at is not None else _now_ms(),
            ),
        )
        assert cursor.lastrowid is not None
        # 只在**第一条**用户消息时自动生成标题：旧会话 title 为空时保持为空，
        # 由列表用首条消息兜底展示，不能被后续聊天内容覆盖（2026-10-24 验收修复）
        if role == "user":
            if session_id == PET_SESSION_ID:
                self._conn.execute(
                    "UPDATE sessions SET title = ? "
                    "WHERE id = ? AND (title IS NULL OR title = '')",
                    (PET_SESSION_TITLE, session_id),
                )
            else:
                prior = self._conn.execute(
                    "SELECT 1 FROM messages "
                    "WHERE session_id = ? AND role = 'user' AND id <> ? LIMIT 1",
                    (session_id, int(cursor.lastrowid)),
                ).fetchone()
                title = title_from_text(content)
                if prior is None and title:
                    self._conn.execute(
                        "UPDATE sessions SET title = ? "
                        "WHERE id = ? AND (title IS NULL OR title = '')",
                        (title, session_id),
                    )
        return int(cursor.lastrowid)

    def delete_message(self, session_id: str, message_id: int) -> bool:
        """删除当前会话的一条消息（工作模式单条删除）；返回是否删到。

        只按 ``session_id + id`` 精确删，防止跨会话误删；调用方随后应重载
        会话内存上下文（application.session.Session.reload_history）。
        """
        cursor = self._conn.execute(
            "DELETE FROM messages WHERE id = ? AND session_id = ?",
            (int(message_id), session_id),
        )
        return cursor.rowcount > 0

    def recent_messages(self, session_id: str, limit: int = 20) -> list[dict[str, Any]]:
        """取最近 limit 条消息（**时间正序**返回，直接供 load_history/history 事件）。

        排序用自增 id 而非 created_at：同毫秒写入的多条消息也能保持插入顺序。
        """
        limit = max(1, min(int(limit), MAX_HISTORY_LIMIT))
        rows = self._conn.execute(
            "SELECT id, session_id, role, content, emotion, created_at FROM messages "
            "WHERE session_id = ? ORDER BY id DESC LIMIT ?",
            (session_id, limit),
        ).fetchall()
        return [dict(row) for row in reversed(rows)]

    def message_count(self, session_id: str | None = None) -> int:
        """消息条数（测试/调试用；session_id 为 None 时统计全库）。"""
        if session_id is None:
            row = self._conn.execute("SELECT COUNT(*) AS n FROM messages").fetchone()
        else:
            row = self._conn.execute(
                "SELECT COUNT(*) AS n FROM messages WHERE session_id = ?", (session_id,)
            ).fetchone()
        return int(row["n"])

    def last_message_at(self, session_id: str) -> int | None:
        """会话最后一条消息的时间戳（毫秒）；无消息返回 None。

        用途：重启后恢复会话时把「记忆提取水位」推到该时间，避免对旧内容
        重复触发提取。
        """
        row = self._conn.execute(
            "SELECT created_at FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT 1",
            (session_id,),
        ).fetchone()
        return int(row["created_at"]) if row is not None else None
