"""用户画像 / 启动称呼引导 WS 链路测试（2026-10-18）。

覆盖：
- ``get_profile`` 只在装配画像存储时注册；无名字/有名字/记忆开关的回执；
- ``note_assistant_message`` 把本地气泡台词补录进会话历史（LLM 与记忆提取的上下文）；
- 未 hello（无会话）时补录静默忽略，不创建空会话。
"""

from __future__ import annotations

import asyncio
import json
import uuid
from pathlib import Path
from typing import Any

from backend.application.chat_pipeline import ChatPipeline
from backend.application.session import SessionManager
from backend.interfaces.ws.dispatcher import build_dispatcher
from backend.interfaces.ws.protocol import PROTOCOL_VERSION, parse_client_message
from backend.modules.chat.history import PET_SESSION_ID
from backend.modules.memory.profile import ProfileStore
from backend.shared.db import connect_db
from fakes import EchoLLMProvider


class FakeCtx:
    def __init__(self, session_id: str | None = "s_test") -> None:
        self.id = "c_test"
        self.authed = True
        self.session_id = session_id
        self.sent: list[tuple[str, dict[str, Any]]] = []
        self.errors: list[tuple[str, str]] = []

    async def send_event(
        self, msg_type: str, data: Any = None, *, reply_to: str | None = None
    ) -> None:
        self.sent.append((msg_type, data or {}))

    async def send_error(
        self, code: Any, message: str, *, fatal: bool = False, reply_to: str | None = None
    ) -> None:
        self.errors.append((str(code), message))

    def request_close(self, code: int, reason: str = "") -> None:
        pass


def make_dispatcher(
    tmp_path: Path,
    *,
    with_profile: bool = True,
    memory_enabled: bool = True,
    sessions: SessionManager | None = None,
):
    profile = ProfileStore(connect_db(tmp_path / "pet.db")) if with_profile else None
    manager = sessions or SessionManager()
    dispatcher = build_dispatcher(
        pipeline=ChatPipeline(provider=EchoLLMProvider()),
        sessions=manager,
        token="t",
        app_version="test",
        profile=profile,
        memory_enabled=lambda: memory_enabled,
    )
    return dispatcher, profile, manager


def raw(msg_type: str, data: dict) -> str:
    return json.dumps(
        {"v": 1, "id": f"t_{uuid.uuid4().hex[:8]}", "type": msg_type, "ts": 0, "data": data}
    )


async def dispatch(dispatcher, ctx: FakeCtx, msg_type: str, data: dict) -> None:
    await dispatcher.dispatch(ctx, parse_client_message(raw(msg_type, data)))


# ---------------------------------------------------------------- get_profile


def test_get_profile_registered_only_when_configured(tmp_path: Path) -> None:
    with_profile, _, _ = make_dispatcher(tmp_path, with_profile=True)
    assert with_profile.has("get_profile")

    without, _, _ = make_dispatcher(tmp_path, with_profile=False)
    assert not without.has("get_profile")


def test_get_profile_without_name(tmp_path: Path) -> None:
    dispatcher, _, _ = make_dispatcher(tmp_path)

    async def scenario() -> None:
        ctx = FakeCtx()
        await dispatch(dispatcher, ctx, "get_profile", {})
        profiles = [d for t, d in ctx.sent if t == "profile"]
        assert profiles and profiles[-1] == {
            "has_name": False,
            "name": None,
            "memory_enabled": True,
        }

    asyncio.run(scenario())


def test_get_profile_returns_name_from_any_known_key(tmp_path: Path) -> None:
    dispatcher, profile, _ = make_dispatcher(tmp_path)
    assert profile is not None
    profile.set("姓名", "小明")

    async def scenario() -> None:
        ctx = FakeCtx()
        await dispatch(dispatcher, ctx, "get_profile", {})
        data = [d for t, d in ctx.sent if t == "profile"][-1]
        assert data["has_name"] is True
        assert data["name"] == "小明"

    asyncio.run(scenario())


def test_get_profile_prefers_称呼(tmp_path: Path) -> None:
    dispatcher, profile, _ = make_dispatcher(tmp_path)
    assert profile is not None
    profile.set("姓名", "小明")
    profile.set("称呼", "明明")

    async def scenario() -> None:
        ctx = FakeCtx()
        await dispatch(dispatcher, ctx, "get_profile", {})
        data = [d for t, d in ctx.sent if t == "profile"][-1]
        assert data["name"] == "明明"

    asyncio.run(scenario())


def test_get_profile_reports_memory_switch(tmp_path: Path) -> None:
    dispatcher, _, _ = make_dispatcher(tmp_path, memory_enabled=False)

    async def scenario() -> None:
        ctx = FakeCtx()
        await dispatch(dispatcher, ctx, "get_profile", {})
        data = [d for t, d in ctx.sent if t == "profile"][-1]
        assert data["memory_enabled"] is False

    asyncio.run(scenario())


# ---------------------------------------------------------------- note_assistant_message


def test_note_assistant_message_appends_history(tmp_path: Path) -> None:
    sessions = SessionManager()
    session = sessions.start("s_test")
    dispatcher, _, _ = make_dispatcher(tmp_path, sessions=sessions)

    async def scenario() -> None:
        ctx = FakeCtx()
        await dispatch(
            dispatcher, ctx, "note_assistant_message", {"text": "你好呀~你叫什么名字呢？"}
        )
        messages = session.recent_messages()
        assert messages[-1].role == "assistant"
        assert messages[-1].content == "你好呀~你叫什么名字呢？"

    asyncio.run(scenario())


def test_note_assistant_message_ignored_without_session(tmp_path: Path) -> None:
    sessions = SessionManager()
    dispatcher, _, _ = make_dispatcher(tmp_path, sessions=sessions)

    async def scenario() -> None:
        ctx = FakeCtx(session_id=None)
        await dispatch(dispatcher, ctx, "note_assistant_message", {"text": "你好"})
        assert sessions.count() == 0  # 不得因补录创建空会话
        assert ctx.errors == []

    asyncio.run(scenario())


def test_note_assistant_message_dedupes_same_text(tmp_path: Path) -> None:
    """同一句本地气泡台词每次启动都会补录：会话里已有就不再写（2026-10-27）。"""
    sessions = SessionManager()
    session = sessions.start("s_test")
    dispatcher, _, _ = make_dispatcher(tmp_path, sessions=sessions)

    async def scenario() -> None:
        ctx = FakeCtx()
        for _ in range(3):
            await dispatch(
                dispatcher, ctx, "note_assistant_message", {"text": "你好呀~你叫什么名字呢？"}
            )
        contents = [m.content for m in session.recent_messages()]
        assert contents.count("你好呀~你叫什么名字呢？") == 1

    asyncio.run(scenario())


def test_hello_pet_reuses_pet_session(tmp_path: Path) -> None:
    """宠物窗 hello 不带 session_id 时固定复用 pet-primary，不再每次新建会话。"""
    sessions = SessionManager()
    dispatcher, _, _ = make_dispatcher(tmp_path, sessions=sessions)

    async def scenario() -> None:
        first = FakeCtx(session_id=None)
        await dispatch(
            dispatcher,
            first,
            "hello",
            {"token": "t", "protocol_version": PROTOCOL_VERSION, "app_version": "test"},
        )
        second = FakeCtx(session_id=None)
        await dispatch(
            dispatcher,
            second,
            "hello",
            {"token": "t", "protocol_version": PROTOCOL_VERSION, "app_version": "test"},
        )
        assert first.session_id == PET_SESSION_ID
        assert second.session_id == PET_SESSION_ID
        assert sessions.count() == 1

    asyncio.run(scenario())
