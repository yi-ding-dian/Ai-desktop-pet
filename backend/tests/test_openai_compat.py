"""modules/llm/openai_compat.py 单测。

覆盖：流式解析（只取 content、跳过 reasoning_content）、请求参数透传、
错误码翻译（§4.1）、密钥脱敏、连通性测试、embed 占位。

说明：openai SDK 3.x 的底层 httpx 依赖不可直接 import，HTTP 状态类异常
（需要 response 对象）用 Mock(spec=...) 构造以验证 isinstance 分派。
"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace
from typing import Any
from unittest.mock import Mock

import openai
import pytest

from backend.modules.llm.openai_compat import (
    OpenAICompatProvider,
    _extract_content,
    _translate,
)
from backend.modules.llm.provider import ChatMessage
from backend.shared.errors import LlmError, LlmErrorCode

KEY = "test-key-0123456789abcdef"


def make_chunk(*, content: str | None = None, reasoning: str | None = None) -> Any:
    """构造形如 SDK ChatCompletionChunk 的假 chunk（delta 同时带两类字段）。"""
    delta = SimpleNamespace(content=content, reasoning_content=reasoning)
    return SimpleNamespace(choices=[SimpleNamespace(delta=delta)])


class FakeClient:
    """假的 AsyncOpenAI 客户端：记录请求，返回预设 chunk 流或抛异常。"""

    def __init__(self, chunks: list[Any] | None = None, *, error: Exception | None = None) -> None:
        self._chunks = list(chunks or [])
        self._error = error
        self.requests: list[dict[str, Any]] = []

    async def __aenter__(self) -> "FakeClient":
        return self

    async def __aexit__(self, *exc_info: Any) -> bool:
        return False

    # 让 client.chat.completions.create 链式访问落到自身
    @property
    def chat(self) -> "FakeClient":
        return self

    @property
    def completions(self) -> "FakeClient":
        return self

    async def create(self, **request: Any) -> Any:
        self.requests.append(request)
        if self._error is not None:
            raise self._error
        chunks = self._chunks

        async def _stream() -> Any:
            for chunk in chunks:
                yield chunk

        return _stream()


def make_provider(client: FakeClient, **overrides: Any) -> OpenAICompatProvider:
    kwargs: dict[str, Any] = dict(
        base_url="http://127.0.0.1:9/v1",
        model="test-model",
        temperature=0.5,
        max_tokens=128,
        key_provider=lambda: KEY,
    )
    kwargs.update(overrides)
    provider = OpenAICompatProvider(**kwargs)
    provider._open_client = lambda key: client  # type: ignore[method-assign]
    return provider


def collect(provider: OpenAICompatProvider) -> list[Any]:
    """同步收集一次流式输出（异常会原样抛出）。"""

    async def _run() -> list[Any]:
        return [c async for c in provider.stream_chat([ChatMessage("user", "hi")])]

    return asyncio.run(_run())


def fake_exc(cls: type, **attrs: Any) -> Exception:
    """构造能通过 isinstance 检查的假异常（HTTP 状态类异常无法裸构造）。"""
    exc = Mock(spec=cls)
    for name, value in attrs.items():
        setattr(exc, name, value)
    return exc  # type: ignore[return-value]


# ---------------------------------------------------------------- 流式解析


def test_extract_content_skips_reasoning_content() -> None:
    assert _extract_content(make_chunk(reasoning="思考中…")) == ""
    assert _extract_content(make_chunk(content="正文")) == "正文"
    assert _extract_content(SimpleNamespace(choices=[])) == ""
    assert _extract_content(SimpleNamespace(choices=[SimpleNamespace(delta=None)])) == ""


def test_stream_yields_only_content_and_finished_marker() -> None:
    client = FakeClient(
        [
            make_chunk(reasoning="先想"),
            make_chunk(content="你"),
            make_chunk(reasoning="再想"),
            make_chunk(content="好"),
            make_chunk(),  # content 为 None 的尾部 chunk
        ]
    )
    chunks = collect(make_provider(client))

    assert [c.text for c in chunks if c.text] == ["你", "好"]  # reasoning 未混入
    assert chunks[-1].finished is True and chunks[-1].text == ""


def test_request_params_passed_to_sdk() -> None:
    client = FakeClient([make_chunk(content="ok")])
    collect(make_provider(client))

    req = client.requests[0]
    assert req["model"] == "test-model"
    assert req["messages"] == [{"role": "user", "content": "hi"}]
    assert req["stream"] is True
    assert req["temperature"] == 0.5
    assert req["max_tokens"] == 128


def test_opts_override_sampling_params() -> None:
    client = FakeClient([make_chunk(content="ok")])

    async def _run() -> None:
        provider = make_provider(client)
        async for _ in provider.stream_chat(
            [ChatMessage("user", "hi")], temperature=0.1, max_tokens=42
        ):
            pass

    asyncio.run(_run())
    assert client.requests[0]["temperature"] == 0.1
    assert client.requests[0]["max_tokens"] == 42


# ---------------------------------------------------------------- 密钥


def test_missing_key_raises_llm_no_key() -> None:
    provider = make_provider(FakeClient(), key_provider=lambda: None)
    with pytest.raises(LlmError) as excinfo:
        collect(provider)
    assert excinfo.value.code == LlmErrorCode.LLM_NO_KEY


# ---------------------------------------------------------------- 错误翻译


@pytest.mark.parametrize(
    ("exc", "expected"),
    [
        (openai.APITimeoutError(request=None), LlmErrorCode.LLM_TIMEOUT),
        (openai.APIConnectionError(request=None), LlmErrorCode.LLM_NETWORK),
        (fake_exc(openai.AuthenticationError), LlmErrorCode.LLM_AUTH),
        (fake_exc(openai.PermissionDeniedError), LlmErrorCode.LLM_AUTH),
        (fake_exc(openai.RateLimitError), LlmErrorCode.LLM_RATE_LIMIT),
        (fake_exc(openai.BadRequestError), LlmErrorCode.LLM_BAD_REQUEST),
        (fake_exc(openai.NotFoundError), LlmErrorCode.LLM_BAD_REQUEST),
        (fake_exc(openai.UnprocessableEntityError), LlmErrorCode.LLM_BAD_REQUEST),
        (fake_exc(openai.InternalServerError, status_code=503), LlmErrorCode.LLM_UPSTREAM),
        (openai.APIError("boom", request=None, body=None), LlmErrorCode.LLM_UPSTREAM),
    ],
)
def test_translate_maps_to_business_codes(exc: Exception, expected: LlmErrorCode) -> None:
    err = _translate(exc, timeout=60.0)  # type: ignore[arg-type]
    assert isinstance(err, LlmError)
    assert err.code == expected
    assert err.message  # 对用户有可读说明


def test_stream_error_translated() -> None:
    client = FakeClient(error=openai.APITimeoutError(request=None))
    with pytest.raises(LlmError) as excinfo:
        collect(make_provider(client))
    assert excinfo.value.code == LlmErrorCode.LLM_TIMEOUT
    assert "超时" in excinfo.value.message


def test_error_message_redacts_key() -> None:
    """即使上游异常文本夹带 key 明文，翻译后的 message 也必须已脱敏。"""
    client = FakeClient(error=openai.APIError(f"bad key {KEY} rejected", request=None, body=None))
    with pytest.raises(LlmError) as excinfo:
        collect(make_provider(client))

    message = excinfo.value.message
    assert KEY not in message
    assert "****" in message  # 替换为掩码


# ---------------------------------------------------------------- 连通性测试


def test_test_ok() -> None:
    provider = make_provider(FakeClient([make_chunk(content="pong")]))
    ok, message = asyncio.run(provider.test())
    assert ok is True
    assert "test-model" in message


def test_test_failure_returns_reason() -> None:
    provider = make_provider(FakeClient(error=openai.APIConnectionError(request=None)))
    ok, message = asyncio.run(provider.test())
    assert ok is False
    assert "无法连接" in message


def test_test_without_key() -> None:
    provider = make_provider(FakeClient(), key_provider=lambda: None)
    ok, message = asyncio.run(provider.test())
    assert ok is False
    assert "key" in message.lower()


# ---------------------------------------------------------------- embed 占位


def test_embed_not_implemented_yet() -> None:
    provider = make_provider(FakeClient())
    with pytest.raises(NotImplementedError):
        asyncio.run(provider.embed(["文本"]))
