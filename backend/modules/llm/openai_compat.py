"""OpenAI 兼容 LLM provider —— LLMProvider 的真实实现（设计文档 §4.1）。

基于官方 openai SDK 指向任意 OpenAI 兼容端点（DeepSeek / 智谱 / 通义 / Moonshot /
本地 new-api 网关……）。BYOK 三要素（base_url + model + key）在本层闭环：

- key 经 shared.secrets 读取链获取（每次请求时解析，设置面板更新后即时生效）；
- 超时 / 重试 / 错误码翻译在本层完成，对上层只抛业务化的 LlmError（已脱敏）。

关键约定：
- 只取流式 delta.content，天然跳过推理型模型的 delta.reasoning_content（思考过程）；
- 任何日志 / 异常信息不得携带 key 明文（shared.secrets.redact 兜底）。

实现说明：每次请求创建一次性 AsyncOpenAI 客户端（with 块结束即关闭），
避免长驻连接池与密钥缓存的生命周期问题；provider 实例本身无状态、可安全复用。
"""

from __future__ import annotations

from typing import Any, AsyncIterator, Callable, Sequence

import openai
from loguru import logger  # noqa: F401  （预留：需要时可记录请求元信息，注意脱敏）

from backend.modules.llm.provider import ChatMessage, Chunk
from backend.shared.errors import LlmError, LlmErrorCode
from backend.shared.secrets import get_llm_key, redact, register_secret

DEFAULT_TIMEOUT = 60.0  # 秒；流式场景为"相邻数据块间隔"超时
DEFAULT_MAX_RETRIES = 2  # SDK 内建重试（仅连接类错误 / 429 / 5xx，流式开始后不重放）


def _extract_content(chunk: Any) -> str:
    """从流式 chunk 中取出正文增量。

    推理型模型（如 deepseek-flash）的思考过程在 ``delta.reasoning_content``，
    这里只读 ``delta.content``，天然跳过思考、不产生任何标签外的噪音。
    """
    choices = getattr(chunk, "choices", None)
    if not choices:
        return ""
    delta = getattr(choices[0], "delta", None)
    if delta is None:
        return ""
    content = getattr(delta, "content", None)
    return content or ""


def _safe_detail(exc: Exception, limit: int = 160) -> str:
    """第三方异常的安全摘要：压缩空白、截断、已登记密钥一律替换为掩码。"""
    text = " ".join(redact(str(exc)).split())
    return text[:limit] + ("…" if len(text) > limit else "")


def _translate(exc: openai.OpenAIError, *, timeout: float) -> LlmError:
    """把 openai SDK 异常翻译成业务化 LlmError（§4.1：错误码翻译统一在本层）。

    注意判断顺序：SDK 异常存在继承关系（如 APITimeoutError ⊂ APIConnectionError、
    AuthenticationError ⊂ APIStatusError），必须先判子类。
    """
    if isinstance(exc, openai.AuthenticationError):
        return LlmError(LlmErrorCode.LLM_AUTH, "API key 无效或无权限（401），请检查设置中的 key")
    if isinstance(exc, openai.PermissionDeniedError):
        return LlmError(LlmErrorCode.LLM_AUTH, "API key 被拒绝（403），请检查该 key 的权限")
    if isinstance(exc, openai.APITimeoutError):
        return LlmError(
            LlmErrorCode.LLM_TIMEOUT, f"请求超时（{timeout:g}s），请检查网络或稍后重试"
        )
    if isinstance(exc, openai.APIConnectionError):
        return LlmError(LlmErrorCode.LLM_NETWORK, "无法连接 LLM 服务，请检查网络与服务地址")
    if isinstance(exc, openai.RateLimitError):
        return LlmError(LlmErrorCode.LLM_RATE_LIMIT, "触发服务商限流（429），请稍后重试")
    if isinstance(
        exc, (openai.BadRequestError, openai.NotFoundError, openai.UnprocessableEntityError)
    ):
        return LlmError(LlmErrorCode.LLM_BAD_REQUEST, f"请求被服务商拒绝：{_safe_detail(exc)}")
    if isinstance(exc, openai.APIStatusError):
        return LlmError(
            LlmErrorCode.LLM_UPSTREAM,
            f"上游服务错误（HTTP {exc.status_code}）：{_safe_detail(exc)}",
        )
    return LlmError(LlmErrorCode.LLM_UPSTREAM, f"LLM 调用失败：{_safe_detail(exc)}")


class OpenAICompatProvider:
    """OpenAI 兼容协议的 LLMProvider 实现（覆盖任意 base_url 端点）。"""

    def __init__(
        self,
        *,
        base_url: str,
        model: str,
        temperature: float = 0.8,
        max_tokens: int = 768,
        key_provider: Callable[[], str | None] = get_llm_key,
        timeout: float = DEFAULT_TIMEOUT,
        max_retries: int = DEFAULT_MAX_RETRIES,
    ) -> None:
        """
        - key_provider：惰性取 key 的回调（缺省走 shared.secrets 读取链）；
          用回调而非固定值，保证"设置面板更新 key 后下一次请求即生效"；
        - max_tokens：推理型模型思考也消耗 token，默认 768，避免被思考吃光导致空回复。
        """
        self._base_url = base_url
        self._model = model
        self._temperature = temperature
        self._max_tokens = max_tokens
        self._key_provider = key_provider
        self._timeout = timeout
        self._max_retries = max_retries

    # ---------- LLMProvider 协议 ----------

    async def stream_chat(
        self, messages: Sequence[ChatMessage], **opts: Any
    ) -> AsyncIterator[Chunk]:
        """流式对话：逐块产出正文增量，结束后产出 ``Chunk(finished=True)``。

        失败时抛 LlmError（已翻译、已脱敏）；可经 opts 覆盖 temperature / max_tokens / model。
        """
        key = self._resolve_key()
        request: dict[str, Any] = {
            "model": opts.pop("model", self._model),
            "messages": [{"role": m.role, "content": m.content} for m in messages],
            "stream": True,
            "temperature": opts.pop("temperature", self._temperature),
            "max_tokens": opts.pop("max_tokens", self._max_tokens),
        }
        try:
            client = self._open_client(key)
            async with client:  # 请求结束即关闭连接池
                stream = await client.chat.completions.create(**request)
                async for raw in stream:
                    text = _extract_content(raw)
                    if text:
                        yield Chunk(text=text)
        except openai.OpenAIError as exc:
            raise _translate(exc, timeout=self._timeout) from exc
        yield Chunk(text="", finished=True)

    async def embed(self, texts: Sequence[str]) -> list[list[float]]:
        """文本向量化（协议预留）：记忆模块（P3，§4.3）接入时实现。"""
        raise NotImplementedError("embedding 将在记忆模块（P3）接入时实现")

    async def test(self) -> tuple[bool, str]:
        """连通性测试（设置面板「测试连接」，§3.2 test_llm）。

        发一个最小请求：只要上游正常应答（HTTP 200）即视为连通；
        推理型模型思考可能吃满 max_tokens 使正文为空——这不是失败。
        """
        try:
            key = self._resolve_key()
        except LlmError as exc:
            return False, exc.message
        try:
            client = self._open_client(key)
            async with client:
                await client.chat.completions.create(
                    model=self._model,
                    messages=[{"role": "user", "content": "ping"}],
                    max_tokens=16,
                )
        except openai.OpenAIError as exc:
            return False, _translate(exc, timeout=self._timeout).message
        return True, f"连接成功（model={self._model}）"

    # ---------- 内部实现 ----------

    def _resolve_key(self) -> str:
        """解析 API key；未配置抛 LlmError(LLM_NO_KEY)。已解析的 key 登记进脱敏集合。"""
        key = (self._key_provider() or "").strip()
        if not key:
            raise LlmError(LlmErrorCode.LLM_NO_KEY, "未配置 LLM API key，请在设置中填写后再试")
        register_secret(key)
        return key

    def _open_client(self, key: str) -> openai.AsyncOpenAI:
        """创建一次性异步客户端（用完即关；密钥不作为构造参数以外的任何形式外泄）。"""
        return openai.AsyncOpenAI(
            base_url=self._base_url,
            api_key=key,
            timeout=self._timeout,
            max_retries=self._max_retries,
        )
