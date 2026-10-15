"""记忆上下文注入（§4.1/§4.2）单测：format 组装 + ChatPipeline 注入行为。

覆盖：
- build_memory_block：空内容不注入 / 画像 / 记忆 / 两者混合的格式；
- ChatPipeline._build_messages：未装配时单 system（P1/P2 回归）；
  装配后有内容时第二条 system，无内容时不注入；
- 注入 INFO 日志只含条数（隐私：不含记忆全文）；
- pipeline × HistoryStore 集成：一轮对话后 user/assistant 落库（含 emotion）。
"""

from __future__ import annotations

import asyncio
import sqlite3
from typing import Any

from loguru import logger

from backend.application.chat_pipeline import ChatPipeline
from backend.application.session import SessionManager
from backend.modules.chat.history import HistoryStore
from backend.modules.memory.format import MEMORY_BLOCK_HEADER, build_memory_block
from backend.modules.memory.profile import ProfileItem, ProfileStore
from backend.modules.memory.store import Memory, MemoryStore
from backend.shared.db import connect_db
from fakes import ScriptedProvider

# 复用 chat_pipeline 测试的出站端口替身（事件收集）
from test_chat_pipeline import FakeSink


def make_stores(tmp_path) -> tuple[sqlite3.Connection, MemoryStore, ProfileStore]:
    conn = connect_db(tmp_path / "pet.db")
    return conn, MemoryStore(conn), ProfileStore(conn)


# ---------------------------------------------------------------- format


def test_build_memory_block_empty_returns_none() -> None:
    assert build_memory_block([], []) is None


def test_build_memory_block_profile_only() -> None:
    block = build_memory_block(
        [ProfileItem(key="称呼", value="张三", updated_at=1)], []
    )
    assert block is not None
    assert MEMORY_BLOCK_HEADER in block
    assert "[用户画像]" in block and "- 称呼：张三" in block
    assert "[长期记忆]" not in block


def test_build_memory_block_memories_only_and_mixed() -> None:
    memory = Memory(id=1, text="用户喜欢喝拿铁咖啡", kind="preference", importance=0.6, created_at=1)
    block = build_memory_block([], [memory])
    assert block is not None and "- 用户喜欢喝拿铁咖啡" in block
    assert "[长期记忆]" in block and "[用户画像]" not in block

    mixed = build_memory_block(
        [ProfileItem(key="城市", value="杭州", updated_at=1)], [memory]
    )
    assert mixed is not None
    assert "- 城市：杭州" in mixed and "- 用户喜欢喝拿铁咖啡" in mixed


# ---------------------------------------------------------------- pipeline 注入


def build_messages(pipeline: ChatPipeline, sessions: SessionManager, user_text: str) -> list[Any]:
    session = sessions.start("s")
    session.append_message("user", user_text)
    return asyncio.run(pipeline._build_messages(session, user_text=user_text))


def test_pipeline_without_memory_keeps_single_system(tmp_path) -> None:
    pipeline = ChatPipeline(provider=ScriptedProvider([]))
    messages = build_messages(pipeline, SessionManager(), "你好")
    assert [m.role for m in messages] == ["system", "user"]
    assert "小兔" in messages[0].content


def test_pipeline_injects_profile_and_memories(tmp_path) -> None:
    conn, store, profile = make_stores(tmp_path)
    store.add("用户叫张三", "fact", 0.9)
    store.add("用户喜欢喝拿铁咖啡", "preference", 0.6)
    profile.set("称呼", "张三")
    pipeline = ChatPipeline(
        provider=ScriptedProvider([]), memories=store, profile=profile
    )
    messages = build_messages(pipeline, SessionManager(), "你还记得我吗")

    assert [m.role for m in messages] == ["system", "system", "user"]
    block = messages[1].content
    assert MEMORY_BLOCK_HEADER in block
    assert "- 称呼：张三" in block
    assert "- 用户叫张三" in block and "- 用户喜欢喝拿铁咖啡" in block
    conn.close()


def test_pipeline_skips_injection_when_no_memory_content(tmp_path) -> None:
    conn, store, profile = make_stores(tmp_path)
    pipeline = ChatPipeline(
        provider=ScriptedProvider([]), memories=store, profile=profile
    )
    messages = build_messages(pipeline, SessionManager(), "你好")
    assert [m.role for m in messages] == ["system", "user"]  # 空库：不注入第二条 system
    conn.close()


def test_pipeline_injection_log_has_counts_not_text(tmp_path) -> None:
    conn, store, profile = make_stores(tmp_path)
    store.add("用户喜欢喝拿铁咖啡", "preference", 0.6)
    profile.set("称呼", "张三")
    pipeline = ChatPipeline(
        provider=ScriptedProvider([]), memories=store, profile=profile
    )

    records: list[str] = []
    handler_id = logger.add(lambda message: records.append(str(message)), level="INFO")
    try:
        build_messages(pipeline, SessionManager(), "你好")
    finally:
        logger.remove(handler_id)

    injection_logs = [line for line in records if "记忆注入" in line]
    assert injection_logs, "缺少记忆注入的 INFO 日志"
    assert "画像 1 条 / 长期记忆 1 条" in injection_logs[0]
    assert "拿铁咖啡" not in injection_logs[0]  # INFO 级不含记忆全文
    conn.close()


def test_pipeline_recall_failure_degrades_gracefully(tmp_path) -> None:
    """召回抛异常：本轮不注入记忆，但对话继续（不回滚、不报错）。"""

    class ExplodingStore:
        async def recall(self, query: str, **kwargs):  # noqa: ANN003
            raise RuntimeError("模拟召回故障")

        def mark_used(self, ids, **kwargs):  # noqa: ANN001, ANN003
            raise AssertionError("召回失败时不应调用 mark_used")

    pipeline = ChatPipeline(provider=ScriptedProvider([]), memories=ExplodingStore())
    messages = build_messages(pipeline, SessionManager(), "你好")
    assert [m.role for m in messages] == ["system", "user"]


# ---------------------------------------------------------------- pipeline × 持久化集成


def test_turn_persists_messages_with_emotion(tmp_path) -> None:
    conn, _, _ = make_stores(tmp_path)
    history = HistoryStore(conn)
    sessions = SessionManager(store=history)
    session = sessions.start("persist-turn")

    pipeline = ChatPipeline(provider=ScriptedProvider(["你好呀<emo:happy>！"]))
    sink = FakeSink()
    asyncio.run(pipeline.run_turn(sink, session=session, user_text="你好"))

    rows = history.recent_messages("persist-turn", limit=10)
    assert [(r["role"], r["content"]) for r in rows] == [
        ("user", "你好"),
        ("assistant", "你好呀！"),
    ]
    assert rows[1]["emotion"] == "happy"  # 本轮最后情绪随 assistant 消息落库
    conn.close()
