"""application/memory_service.py 单测：空闲判定 / 提取编排 / 水位推进 / 生命周期。

覆盖：
- _is_idle：超时且自上次提取后有新消息才到期；
- extract_now / extract_idle：fake provider（流式吐 JSON）→ 入库 + 画像 + 水位推进；
  已提取且无新消息不再触发；提取失败也推进水位（防反复重试）；
- 后台循环 start/stop（短周期实测一次提取）。

fake provider 只实现 stream_chat（鸭子类型满足 LLMProvider 协议书面的调用面）。
"""

from __future__ import annotations

import asyncio
import sqlite3
import time

from backend.application.memory_service import MemoryService
from backend.application.session import Session, SessionManager
from backend.modules.chat.history import HistoryStore
from backend.modules.llm.provider import Chunk
from backend.modules.memory.profile import ProfileStore
from backend.modules.memory.store import MemoryStore
from backend.shared.db import connect_db

DAY_MS = 86_400_000
PAYLOAD = (
    '{"memories": [{"text": "用户叫张三", "kind": "fact", "importance": 0.9}],'
    ' "profile": [{"key": "称呼", "value": "张三"}]}'
)


class FakeStreamProvider:
    """流式吐固定文本（模拟对话模型输出提取 JSON）。"""

    def __init__(self, payload: str = PAYLOAD, *, delay: float = 0.0) -> None:
        self.payload = payload
        self.delay = delay

    async def stream_chat(self, messages, **opts):  # noqa: ANN001, ANN003
        for piece in (self.payload[: len(self.payload) // 2], self.payload[len(self.payload) // 2 :]):
            if self.delay:
                await asyncio.sleep(self.delay)
            yield Chunk(text=piece)


class FailingProvider:
    """每次调用都抛异常（模拟网关 5xx）。"""

    async def stream_chat(self, messages, **opts):  # noqa: ANN001, ANN003
        raise RuntimeError("模拟网关故障")
        yield  # pragma: no cover


def make_env(tmp_path):
    conn = connect_db(tmp_path / "pet.db")
    history = HistoryStore(conn)
    store = MemoryStore(conn)
    profile = ProfileStore(conn)
    sessions = SessionManager(store=history)
    return conn, history, store, profile, sessions


def make_service(
    history, store, profile, sessions, provider, *, idle_seconds: float = 300.0
) -> MemoryService:
    return MemoryService(
        provider=provider,
        store=store,
        profile_store=profile,
        sessions=sessions,
        history=history,
        idle_seconds=idle_seconds,
        check_interval_seconds=15.0,
        prompt="（测试提示词）",
    )


# ---------------------------------------------------------------- 空闲判定


def test_is_idle_rules(tmp_path) -> None:
    conn, history, store, profile, sessions = make_env(tmp_path)
    service = make_service(history, store, profile, sessions, FakeStreamProvider(), idle_seconds=300)
    session = Session(id="s", created_at=0, last_active_at=1_000_000, last_extracted_at=0)

    now = 1_000_000 + 300_000
    assert service._is_idle(session, now) is True  # 恰好到期且有新内容
    assert service._is_idle(session, now - 1) is False  # 还差 1ms
    session.last_extracted_at = 1_000_000
    assert service._is_idle(session, now) is False  # 上次提取后无新消息
    session.append_message("user", "又有新消息")  # touch 更新活跃时间
    assert service._is_idle(session, session.last_active_at + 300_000) is True
    conn.close()


# ---------------------------------------------------------------- 提取编排


def test_extract_now_persists_and_advances_watermark(tmp_path) -> None:
    conn, history, store, profile, sessions = make_env(tmp_path)
    service = make_service(history, store, profile, sessions, FakeStreamProvider())
    session = sessions.start("s1")
    session.append_message("user", "我叫张三")
    session.append_message("assistant", "记住啦")

    result = asyncio.run(service.extract_now(session))
    assert result.ok and [m.text for m in result.added] == ["用户叫张三"]
    assert profile.get("称呼") == "张三"
    assert session.last_extracted_at == session.last_active_at  # 水位已推进
    # 无新消息时不再触发（即使再调用也被水位挡住）
    assert service._is_idle(session, session.last_active_at + 10 * 60 * 1000) is False
    conn.close()


def test_extract_idle_scans_due_sessions_only(tmp_path) -> None:
    conn, history, store, profile, sessions = make_env(tmp_path)
    service = make_service(history, store, profile, sessions, FakeStreamProvider(), idle_seconds=0.05)
    due = sessions.start("due")
    due.append_message("user", "我叫张三")
    fresh = sessions.start("fresh")
    fresh.append_message("user", "刚说的话")
    due.last_active_at -= 1000  # 人为置为"早已空闲"
    fresh.last_active_at = int(time.time() * 1000)  # 刚活跃：不到期

    results = asyncio.run(service.extract_idle())
    assert [sid for sid, _ in results] == ["due"]
    assert store.count() == 1
    conn.close()


def test_extract_failure_still_advances_watermark(tmp_path) -> None:
    """LLM 失败：不写库、水位照常推进（避免每周期反复重试白烧 token）。"""
    conn, history, store, profile, sessions = make_env(tmp_path)
    service = make_service(history, store, profile, sessions, FailingProvider())
    session = sessions.start("s1")
    session.append_message("user", "你好")

    result = asyncio.run(service.extract_now(session))
    assert result.ok is False and store.count() == 0
    assert session.last_extracted_at == session.last_active_at
    conn.close()


def test_extract_empty_session_is_noop(tmp_path) -> None:
    conn, history, store, profile, sessions = make_env(tmp_path)
    service = make_service(history, store, profile, sessions, FakeStreamProvider())
    session = sessions.start("empty")
    result = asyncio.run(service.extract_now(session))
    assert result.ok and result.note  # "无对话消息，跳过"
    conn.close()


def test_extract_new_message_during_previous_extraction_is_not_lost(tmp_path) -> None:
    """提取期间又来了新消息：水位只推进到快照，下轮会对新内容再次提取。"""
    conn, history, store, profile, sessions = make_env(tmp_path)
    service = make_service(history, store, profile, sessions, FakeStreamProvider())
    session = sessions.start("s1")
    session.append_message("user", "第一句")
    snapshot = session.last_active_at

    async def scenario() -> None:
        task = asyncio.create_task(service.extract_now(session))
        await asyncio.sleep(0)  # 让提取协程先跑起来（拿到快照）
        session.append_message("user", "提取期间的新消息")
        await task

    asyncio.run(scenario())
    assert session.last_extracted_at == snapshot < session.last_active_at
    assert service._is_idle(session, session.last_active_at + 300_000) is True
    conn.close()


# ---------------------------------------------------------------- 后台循环


def test_background_loop_extracts_idle_session(tmp_path) -> None:
    """start() 后：短周期循环把已空闲会话的提取跑通；stop() 干净收尾。"""
    conn, history, store, profile, sessions = make_env(tmp_path)
    service = MemoryService(
        provider=FakeStreamProvider(delay=0.01),
        store=store,
        profile_store=profile,
        sessions=sessions,
        history=history,
        idle_seconds=0.05,
        check_interval_seconds=0.05,
        prompt="（测试提示词）",
    )
    session = sessions.start("bg")
    session.append_message("user", "我叫张三")

    async def scenario() -> None:
        service.start()
        try:
            for _ in range(200):  # 最多等 2s
                if store.count() > 0:
                    break
                await asyncio.sleep(0.01)
        finally:
            await service.stop()

    asyncio.run(scenario())
    assert store.count() == 1
    assert profile.get("称呼") == "张三"
    conn.close()
