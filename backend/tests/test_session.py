"""application/session.py 单测：内存态多轮历史的保留与顺序。"""

from __future__ import annotations

from backend.application.session import HISTORY_MAX_TURNS, SessionManager


def test_history_keeps_only_recent_turns() -> None:
    sessions = SessionManager()
    session = sessions.start("s1")
    total = HISTORY_MAX_TURNS + 2
    for i in range(total):
        session.append_message("user", f"u{i}")
        session.append_message("assistant", f"a{i}")

    recent = session.recent_messages()
    assert len(recent) == HISTORY_MAX_TURNS * 2
    assert recent[0].content == "u2"  # 最旧两轮已被淘汰
    assert recent[-1].content == f"a{total - 1}"


def test_history_preserves_insertion_order() -> None:
    session = SessionManager().start("s")
    session.append_message("user", "一")
    session.append_message("assistant", "二")
    assert [(m.role, m.content) for m in session.recent_messages()] == [
        ("user", "一"),
        ("assistant", "二"),
    ]


def test_sessions_are_isolated() -> None:
    sessions = SessionManager()
    a = sessions.start("a")
    b = sessions.start("b")
    a.append_message("user", "只有 a 的消息")
    assert b.recent_messages() == []


def test_start_reuses_existing_session() -> None:
    sessions = SessionManager()
    first = sessions.start("same")
    first.append_message("user", "hi")
    again = sessions.start("same")
    assert again is first
    assert len(again.recent_messages()) == 1
