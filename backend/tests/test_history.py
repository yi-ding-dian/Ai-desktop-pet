"""modules/chat/history.py（SQLite 会话与消息读写）+ 会话恢复的单测。

覆盖：
- sessions/messages CRUD 与时间正序返回；
- 持久化：关连接重开（模拟进程重启）后数据仍在；
- SessionManager 从库恢复会话（历史装载、水位初始化、不重复落库）；
- Session 落库（append_message 增量写库 + emotion 列）。
"""

from __future__ import annotations

import sqlite3

from backend.application.session import HISTORY_MAX_TURNS, SessionManager
from backend.modules.chat.history import HistoryStore
from backend.shared.db import connect_db


def open_store(tmp_path, name: str = "pet.db") -> tuple[sqlite3.Connection, HistoryStore]:
    conn = connect_db(tmp_path / name)
    return conn, HistoryStore(conn)


# ---------------------------------------------------------------- 建库 / CRUD


def test_schema_created_and_session_lifecycle(tmp_path) -> None:
    conn, store = open_store(tmp_path)
    tables = {
        row[0]
        for row in conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table'"
        ).fetchall()
    }
    assert {"sessions", "messages", "memories", "profile"} <= tables
    # memories_vec 本次不建（向量降级，见 shared/db.py 注释）
    assert "memories_vec" not in tables

    assert not store.session_exists("s1")
    store.create_session("s1", created_at=1000)
    assert store.session_exists("s1")
    assert store.get_session("s1") is not None
    assert store.get_session("s1")["created_at"] == 1000
    assert store.get_session("missing") is None

    store.end_session("s1", ended_at=2000)
    assert store.get_session("s1")["ended_at"] == 2000
    conn.close()


def test_messages_round_trip_in_time_order(tmp_path) -> None:
    conn, store = open_store(tmp_path)
    store.create_session("s1", created_at=1)
    store.append_message("s1", "user", "你好", created_at=10)
    store.append_message("s1", "assistant", "你也好", emotion="happy", created_at=11)
    store.append_message("s1", "user", "今天天气如何", created_at=12)

    recent = store.recent_messages("s1", limit=10)
    assert [m["role"] for m in recent] == ["user", "assistant", "user"]
    assert [m["content"] for m in recent] == ["你好", "你也好", "今天天气如何"]
    assert recent[1]["emotion"] == "happy"
    assert recent[0]["emotion"] is None
    assert recent[0]["created_at"] == 10
    assert store.message_count("s1") == 3
    assert store.last_message_at("s1") == 12
    assert store.last_message_at("nope") is None
    conn.close()


def test_recent_messages_limit_returns_latest_in_order(tmp_path) -> None:
    conn, store = open_store(tmp_path)
    for i in range(10):
        store.append_message("s1", "user", f"m{i}", created_at=i)
    recent = store.recent_messages("s1", limit=3)
    assert [m["content"] for m in recent] == ["m7", "m8", "m9"]
    conn.close()


def test_append_message_autocreates_session(tmp_path) -> None:
    """兜底：未显式 create_session 也不会因外键失败。"""
    conn, store = open_store(tmp_path)
    store.append_message("auto", "user", "hi")
    assert store.session_exists("auto")
    conn.close()


def test_data_survives_reopen(tmp_path) -> None:
    """模拟进程重启：关闭连接重开后历史与记忆仍在。"""
    db_file = tmp_path / "pet.db"
    conn1 = connect_db(db_file)
    HistoryStore(conn1).append_message("s1", "user", "重启前的话", created_at=5)
    conn1.close()

    conn2 = connect_db(db_file)
    store2 = HistoryStore(conn2)
    messages = store2.recent_messages("s1", limit=10)
    assert len(messages) == 1 and messages[0]["content"] == "重启前的话"
    conn2.close()


# ---------------------------------------------------------------- SessionManager 恢复


def test_session_manager_restores_history_after_restart(tmp_path) -> None:
    """P1 欠账"重启后会话还在"：新 manager（同库）恢复旧会话的历史。"""
    conn, store = open_store(tmp_path)
    manager1 = SessionManager(store=store)
    session = manager1.start("persist-1")
    session.append_message("user", "我叫张三", emotion=None)
    session.append_message("assistant", "记住啦", emotion="happy")
    assert session.id == "persist-1"
    conn.close()

    # 重启：新连接 + 新 manager
    conn2, store2 = open_store(tmp_path)
    manager2 = SessionManager(store=store2)
    restored = manager2.start("persist-1")
    assert restored is not manager1
    assert [(m.role, m.content) for m in restored.recent_messages()] == [
        ("user", "我叫张三"),
        ("assistant", "记住啦"),
    ]
    # 恢复不重复落库（append 才写库）
    assert store2.message_count("persist-1") == 2
    # 水位 = 最后一条消息时间：重启后不会对旧内容立即重复提取
    assert restored.last_extracted_at == store2.last_message_at("persist-1")
    conn2.close()


def test_restore_keeps_only_recent_turns(tmp_path) -> None:
    conn, store = open_store(tmp_path)
    manager = SessionManager(store=store)
    session = manager.start("long")
    total = HISTORY_MAX_TURNS + 5
    for i in range(total):
        session.append_message("user", f"u{i}")
        session.append_message("assistant", f"a{i}")
    conn.close()

    conn2, store2 = open_store(tmp_path)
    restored = SessionManager(store=store2).start("long")
    recent = restored.recent_messages()
    assert len(recent) == HISTORY_MAX_TURNS * 2
    assert recent[0].content == f"u{total - HISTORY_MAX_TURNS}"
    conn2.close()


def test_unknown_session_id_creates_fresh_session(tmp_path) -> None:
    conn, store = open_store(tmp_path)
    manager = SessionManager(store=store)
    session = manager.start("brand-new")
    assert session.recent_messages() == []
    assert store.session_exists("brand-new")
    conn.close()


def test_session_works_without_store(tmp_path) -> None:
    """未装配 store 时纯内存（既有单测场景不破坏）。"""
    session = SessionManager().start("mem-only")
    session.append_message("user", "hi")
    assert [m.content for m in session.recent_messages()] == ["hi"]
