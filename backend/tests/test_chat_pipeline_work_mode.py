"""工作模式（2026-10-18）：单轮选项、联网过滤、推理流。

覆盖：
- ``options.search=False``：只移除 web_search/web_fetch，其余工具保留；
- 推理增量以 ``reasoning`` 事件先于正文 token 推送（网关返回时）。
"""

from __future__ import annotations

import asyncio
from typing import Any, AsyncIterator, Sequence

from backend.application.chat_pipeline import ChatPipeline, TurnOptions
from backend.application.session import SessionManager
from backend.modules.llm.provider import ChatMessage, Chunk
from backend.modules.tools import build_default_registry
from backend.shared.config import AppConfig
from fakes import FakeLLMProvider


class Sink:
    """收集事件序列的最小 ReplySink 替身。"""

    def __init__(self) -> None:
        self.events: list[tuple[str, dict[str, Any]]] = []

    async def state(self, state: str) -> None:
        self.events.append(("state", {"state": state}))

    async def reply_start(self, message_id: str) -> None:
        self.events.append(("reply_start", {"message_id": message_id}))

    async def reasoning(self, message_id: str, text: str) -> None:
        self.events.append(("reasoning", {"text": text}))

    async def token(self, message_id: str, text: str) -> None:
        self.events.append(("token", {"text": text}))

    async def sentence(self, message_id: str, index: int, text: str) -> None:
        self.events.append(("sentence", {"text": text}))

    async def emotion(self, message_id: str, emotion: str, intensity: float) -> None:
        self.events.append(("emotion", {"emotion": emotion}))

    async def reply_end(
        self, message_id: str, full_text: str, *, interrupted: bool = False
    ) -> None:
        self.events.append(("reply_end", {"full_text": full_text}))

    async def tool_call(self, tool_id: str, name: str, args: dict) -> None:
        self.events.append(("tool_call", {"name": name}))

    async def error(self, code: str, message: str) -> None:
        self.events.append(("error", {"code": code, "message": message}))

    async def notice(self, code: str, message: str, level: str = "info") -> None:
        self.events.append(("notice", {"code": code, "message": message}))

    async def send_binary(self, frame: bytes) -> None:
        pass

    def types(self) -> list[str]:
        return [kind for kind, _ in self.events]

    def data_of(self, kind: str) -> list[dict[str, Any]]:
        return [data for event, data in self.events if event == kind]


class SearchStub:
    """联网服务替身（只用于注册 web_search / web_fetch 工具）。"""

    async def search_from_tool(self, args: dict, user_text: str = "") -> dict:
        return {"ok": True, "code": "search_ok", "message": "ok", "model_content": "x"}

    async def fetch_from_tool(self, args: dict) -> dict:
        return {"ok": True, "code": "fetch_ok", "message": "ok", "model_content": "x"}


class ReasoningProvider:
    """先吐推理增量、再吐正文的 provider 替身。"""

    def __init__(self, reasoning: Sequence[str], text: Sequence[str]) -> None:
        self._reasoning = list(reasoning)
        self._text = list(text)
        self.seen_opts: list[dict[str, Any]] = []

    async def stream_chat(
        self, messages: Sequence[ChatMessage], **opts: Any
    ) -> AsyncIterator[Chunk]:
        self.seen_opts.append(dict(opts))
        for piece in self._reasoning:
            yield Chunk(reasoning=piece)
        for piece in self._text:
            yield Chunk(text=piece)
        yield Chunk(text="", finished=True)


def make_config(*, base_url: str = "https://api.deepseek.com/v1") -> AppConfig:
    return AppConfig.model_validate(
        {
            "llm": {
                "base_url": base_url,
                "model": "deepseek-flash",
                "max_tokens": 768,
            }
        }
    )


def run(
    provider: Any,
    *,
    options: TurnOptions | None,
    config: AppConfig | None = None,
    tools: Any | None = None,
) -> Sink:
    sessions = SessionManager()
    session = sessions.start("work")
    sink = Sink()
    pipeline = ChatPipeline(
        provider=provider,
        tools=tools,
        config=(lambda: config) if config is not None else None,
    )
    asyncio.run(
        pipeline.run_turn(
            sink, session=session, user_text="你好", options=options
        )
    )
    return sink


# ---------------------------------------------------------------- 联网开关


def test_search_false_removes_only_web_tools() -> None:
    provider = FakeLLMProvider(pieces=["好"])
    run(
        provider,
        options=TurnOptions(search=False),
        config=make_config(),
        tools=build_default_registry(search=SearchStub()),
    )

    names = [item["function"]["name"] for item in provider.seen_opts[0]["tools"]]
    assert "web_search" not in names and "web_fetch" not in names
    assert "open_settings" in names and "open_work" in names
    # 关闭搜索时不附加“优先联网”提示
    system_texts = [
        m.content for m in provider.seen_messages[0] if m.role == "system"
    ]
    assert not any("本轮已开启联网搜索" in text for text in system_texts)


def test_search_true_adds_hint_and_keeps_web_tools() -> None:
    provider = FakeLLMProvider(pieces=["好"])
    run(
        provider,
        options=TurnOptions(search=True),
        config=make_config(),
        tools=build_default_registry(search=SearchStub()),
    )

    names = [item["function"]["name"] for item in provider.seen_opts[0]["tools"]]
    assert "web_search" in names and "web_fetch" in names
    system_texts = [
        m.content for m in provider.seen_messages[0] if m.role == "system"
    ]
    assert any("本轮已开启联网搜索" in text for text in system_texts)


def test_options_none_keeps_legacy_behavior() -> None:
    """旧调用（无 options）不加提示、不移除工具、不切模型。"""
    provider = FakeLLMProvider(pieces=["好"])
    run(
        provider,
        options=None,
        config=make_config(),
        tools=build_default_registry(search=SearchStub()),
    )

    opts = provider.seen_opts[0]
    assert "model" not in opts
    names = [item["function"]["name"] for item in opts["tools"]]
    assert "web_search" in names and "web_fetch" in names
    system_texts = [
        m.content for m in provider.seen_messages[0] if m.role == "system"
    ]
    assert not any("本轮已开启联网搜索" in text for text in system_texts)


# ---------------------------------------------------------------- 推理流


def test_reasoning_events_precede_tokens() -> None:
    provider = ReasoningProvider(reasoning=["先想", "再想"], text=["答", "案"])
    sink = run(provider, options=None, config=make_config())

    types = sink.types()
    first_reasoning = types.index("reasoning")
    first_token = types.index("token")
    assert first_reasoning < first_token
    assert "".join(d["text"] for d in sink.data_of("reasoning")) == "先想再想"
    assert "".join(d["text"] for d in sink.data_of("token")) == "答案"
