"""SessionReplySink 单测（2026-10-24）：回合事件带 session_id + 前台门控。"""

from __future__ import annotations

import asyncio
from typing import Any

from backend.interfaces.ws.server import SessionReplySink


class FakeCtx:
    def __init__(self, foreground: str | None) -> None:
        self.foreground_session_id = foreground
        self.sent: list[tuple[str, dict[str, Any]]] = []
        self.binary = 0

    async def send_event(self, msg_type: str, data: Any = None, **_kwargs: Any) -> None:
        self.sent.append((msg_type, dict(data or {})))

    async def send_binary(self, _frame: bytes) -> None:
        self.binary += 1


def test_turn_events_carry_session_id() -> None:
    async def scenario() -> None:
        ctx = FakeCtx("a")
        sink = SessionReplySink(ctx, "a")  # type: ignore[arg-type]
        await sink.reply_start("m1")
        await sink.token("m1", "hi")
        await sink.reply_end("m1", "hi")
        assert [name for name, _ in ctx.sent] == ["reply_start", "token", "reply_end"]
        assert all(data.get("session_id") == "a" for _, data in ctx.sent)

    asyncio.run(scenario())


def test_background_sink_suppresses_state_and_voice() -> None:
    async def scenario() -> None:
        ctx = FakeCtx("a")
        background = SessionReplySink(ctx, "b")  # type: ignore[arg-type]
        await background.state("thinking")
        await background.emotion("m1", "happy", 1.0)
        await background.sentence("m1", 0, "hi")
        await background.send_binary(b"\0")
        assert ctx.sent == []
        assert ctx.binary == 0

        ctx.foreground_session_id = "b"
        await background.state("thinking")
        await background.send_binary(b"\0")
        assert ctx.sent[0][0] == "state"
        assert ctx.binary == 1

    asyncio.run(scenario())
