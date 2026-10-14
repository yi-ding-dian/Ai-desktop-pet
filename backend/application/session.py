"""会话生命周期管理（P1 单会话简版）。

维护 session_id 的生成与续期；历史落库（SQLite）在后续步骤接入，
届时由本模块统一承担会话数据的所有权（高内聚原则）。
"""

from __future__ import annotations

import time
import uuid
from dataclasses import dataclass


def _now_ms() -> int:
    return int(time.time() * 1000)


@dataclass
class Session:
    """一个会话。"""

    id: str
    created_at: int
    last_active_at: int

    def touch(self) -> None:
        """更新活跃时间。"""
        self.last_active_at = _now_ms()


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
