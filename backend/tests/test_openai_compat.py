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
    provider._open_client = lambda key, **kw: client  # type: ignore[method-assign]
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


def fake_auth_error() -> Exception:
    """可 raise 的 AuthenticationError 实例（绕过需要 response 对象的构造）：

    Mock(spec=...) 无法被 raise（非 BaseException 实例），probe 走查需要真异常。
    """

    class _FakeAuthError(openai.AuthenticationError):
        def __init__(self) -> None:
            Exception.__init__(self, "模拟 401：key 无效")
            self.status_code = 401
            self.response = None
            self.body = None

    return _FakeAuthError()


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


# ---------------------------------------------------------------- 未配置态（首启引导，base_url 空）


def test_stream_chat_without_base_url_raises_not_configured() -> None:
    """未配置 AI 服务（base_url 空）：明确引导错误，不发请求、不抛网络层模糊错误。"""
    provider = OpenAICompatProvider(
        base_url="", model="test-model", key_provider=lambda: KEY
    )

    with pytest.raises(LlmError) as excinfo:
        collect(provider)

    assert excinfo.value.code == LlmErrorCode.LLM_NOT_CONFIGURED
    assert "设置" in excinfo.value.message  # 引导去设置里选服务商


def test_test_and_probe_without_base_url_give_guidance() -> None:
    async def scenario() -> None:
        provider = OpenAICompatProvider(
            base_url="   ", model="test-model", key_provider=lambda: KEY
        )

        ok, message = await provider.test()
        assert ok is False and "设置" in message

        result = await provider.probe()
        assert result.ok is False
        assert "设置" in result.message
        assert result.models is None

    asyncio.run(scenario())


def test_probe_with_override_url_works_even_when_instance_unconfigured() -> None:
    """设置面板"先测再存"：实例未配置时，入参带地址仍可正常探测。"""

    async def scenario() -> None:
        client = ProbeClient(models=["m1"])
        provider, opened = make_probe_provider(client, base_url="")

        result = await provider.probe(base_url="https://api.example.com/v1", model="m1")

        assert result.ok is True
        assert opened["base_url"] == "https://api.example.com/v1"

    asyncio.run(scenario())


# ---------------------------------------------------------------- 连通性探测（probe，§3.2 test_llm）

OVERRIDE_KEY = "override-key-0123456789"


class ProbeClient:
    """probe 用替身客户端：chat 可配置成功/抛错，models.list 可配置列表/抛错。"""

    def __init__(
        self,
        *,
        chat_error: Exception | None = None,
        models: list[str] | None = None,
        models_error: Exception | None = None,
    ) -> None:
        self.chat_error = chat_error
        self._models = models
        self.models_error = models_error
        self.chat_requests: list[dict[str, Any]] = []
        self.model_requests = 0

    async def __aenter__(self) -> "ProbeClient":
        return self

    async def __aexit__(self, *exc_info: Any) -> bool:
        return False

    # 让 client.chat.completions.create / client.models.list 链式访问落到自身
    @property
    def chat(self) -> "ProbeClient":
        return self

    @property
    def completions(self) -> "ProbeClient":
        return self

    @property
    def models(self) -> "ProbeClient":
        return self

    async def create(self, **request: Any) -> Any:
        self.chat_requests.append(request)
        if self.chat_error is not None:
            raise self.chat_error
        return SimpleNamespace()

    async def list(self) -> Any:
        self.model_requests += 1
        if self.models_error is not None:
            raise self.models_error
        return SimpleNamespace(data=[SimpleNamespace(id=mid) for mid in (self._models or [])])


def make_probe_provider(
    client: ProbeClient, **overrides: Any
) -> tuple[OpenAICompatProvider, dict[str, Any]]:
    """装配 provider 并把 _open_client 换成替身；返回 (provider, 客户端构造参数快照)。"""
    kwargs: dict[str, Any] = dict(
        base_url="http://127.0.0.1:9/v1", model="test-model", key_provider=lambda: KEY
    )
    kwargs.update(overrides)
    provider = OpenAICompatProvider(**kwargs)
    opened: dict[str, Any] = {}

    def fake_open(key: str, **kw: Any) -> ProbeClient:
        opened.update({"key": key, **kw})
        return client

    provider._open_client = fake_open  # type: ignore[method-assign]
    return provider, opened


def test_probe_success_with_models_and_minimal_request() -> None:
    async def scenario() -> None:
        client = ProbeClient(models=["m1", "m2"])
        provider, opened = make_probe_provider(client)

        result = await provider.probe()

        assert result.ok is True
        assert "连接成功" in result.message
        assert result.models == ["m1", "m2"]
        # 最小 chat 请求：max_tokens=1（验证鉴权与地址）
        assert client.chat_requests[0]["max_tokens"] == 1
        assert client.chat_requests[0]["model"] == "test-model"
        assert client.model_requests == 1
        # 探测参数：10s 超时、不重试；key 来自 key_provider
        assert opened == {
            "key": KEY,
            "base_url": "http://127.0.0.1:9/v1",
            "timeout": 10.0,
            "max_retries": 0,
        }

    asyncio.run(scenario())


def test_probe_auth_failure_explains_and_still_fetches_models() -> None:
    async def scenario() -> None:
        client = ProbeClient(chat_error=fake_auth_error(), models=["m1"])
        provider, _ = make_probe_provider(client)

        result = await provider.probe()

        assert result.ok is False
        assert "401" in result.message  # 失败说明具体原因
        assert result.models == ["m1"]  # 仍尽力拉列表（即使 chat 失败也可能可选用）

    asyncio.run(scenario())


def test_probe_connection_and_timeout_reasons() -> None:
    async def scenario() -> None:
        p1, _ = make_probe_provider(
            ProbeClient(chat_error=openai.APIConnectionError(request=None))
        )
        r1 = await p1.probe()
        assert r1.ok is False and "无法连接" in r1.message

        p2, _ = make_probe_provider(
            ProbeClient(chat_error=openai.APITimeoutError(request=None))
        )
        r2 = await p2.probe()
        assert r2.ok is False and "超时" in r2.message and "10" in r2.message

    asyncio.run(scenario())


def test_probe_models_failure_is_silent() -> None:
    async def scenario() -> None:
        client = ProbeClient(models_error=openai.APIError("nope", request=None, body=None))
        provider, _ = make_probe_provider(client)

        result = await provider.probe()

        assert result.ok is True  # 拉不到列表不算失败（前端降级为手填）
        assert result.models is None

    asyncio.run(scenario())


def test_probe_overrides_target_without_leaking_key() -> None:
    async def scenario() -> None:
        client = ProbeClient()
        provider, opened = make_probe_provider(client)

        result = await provider.probe(
            base_url="https://other.example/v1", model="m9", api_key=OVERRIDE_KEY
        )

        assert opened["base_url"] == "https://other.example/v1"
        assert opened["key"] == OVERRIDE_KEY
        assert client.chat_requests[0]["model"] == "m9"
        assert result.models is None  # 空列表 → 省略
        assert OVERRIDE_KEY not in result.message  # 结果不夹带明文

    asyncio.run(scenario())


def test_probe_without_any_key_does_not_send_request() -> None:
    async def scenario() -> None:
        client = ProbeClient()
        provider, opened = make_probe_provider(client, key_provider=lambda: None)

        result = await provider.probe()

        assert result.ok is False
        assert "key" in result.message.lower()
        assert client.chat_requests == []  # 未配置 key：不发请求
        assert opened == {}  # 未构造客户端

    asyncio.run(scenario())


def test_probe_unexpected_error_wrapped_as_result() -> None:
    """非 SDK 异常也要给面板一个可读结论，不外抛。"""

    async def scenario() -> None:
        client = ProbeClient(chat_error=RuntimeError("boom 意外"))
        provider, _ = make_probe_provider(client)

        result = await provider.probe()

        assert result.ok is False
        assert "连接测试异常" in result.message
        assert "boom" in result.message

    asyncio.run(scenario())
