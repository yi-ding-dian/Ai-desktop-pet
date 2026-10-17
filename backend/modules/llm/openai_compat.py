"""OpenAI 兼容 LLM provider —— LLMProvider 的真实实现（设计文档 §4.1）。

基于官方 openai SDK 指向任意 OpenAI 兼容端点（DeepSeek / 智谱 / 通义 / Moonshot /
本地 new-api 网关……）。BYOK 三要素（base_url + model + key）在本层闭环：

- key 经 shared.secrets 读取链获取（每次请求时解析，设置面板更新后即时生效）；
- 超时 / 重试 / 错误码翻译在本层完成，对上层只抛业务化的 LlmError（已脱敏）。

关键约定：
- 只取流式 delta.content，天然跳过推理型模型的 delta.reasoning_content（思考过程）；
- 请求带 ``tools`` 时（由调用方经 opts 传入，本域不依赖 tools 域），
  ``delta.tool_calls`` 分片原样搬运为 ``Chunk.tool_delta``（不做归组 / 拼接，
  那是调用方的职责；见 ``_extract_tool_deltas``）；
- 任何日志 / 异常信息不得携带 key 明文（shared.secrets.redact 兜底）。

实现说明：每次请求创建一次性 AsyncOpenAI 客户端（with 块结束即关闭），
避免长驻连接池与密钥缓存的生命周期问题；provider 实例本身无状态、可安全复用。
"""

from __future__ import annotations

from typing import Any, AsyncIterator, Callable, Sequence

import openai
from loguru import logger  # noqa: F401  （预留：需要时可记录请求元信息，注意脱敏）

from backend.modules.llm.provider import ChatMessage, Chunk, ProbeResult, ToolCallDelta
from backend.shared.errors import LlmError, LlmErrorCode
from backend.shared.secrets import get_llm_key, redact, register_secret

DEFAULT_TIMEOUT = 60.0  # 秒；流式场景为"相邻数据块间隔"超时
DEFAULT_MAX_RETRIES = 2  # SDK 内建重试（仅连接类错误 / 429 / 5xx，流式开始后不重放）
#: 「测试连接」探测超时（秒）——给足时间，避免慢网关/首字节慢被误报为连不上
PROBE_TIMEOUT = 10.0
#: 未配置 AI 服务（base_url 为空）时的引导文案——首启引导：去设置里选服务商
NOT_CONFIGURED_MESSAGE = "还没有配置 AI 服务，打开设置里选一个服务商即可"


def _message_payload(message: ChatMessage) -> dict[str, Any]:
    """ChatMessage → OpenAI chat.completions messages 项。

    无图片：``content`` 仍是字符串（与旧版逐字段一致，兼容所有纯文本网关）；
    有图片：content 改为多模态数组 ``[{type:text}, {type:image_url}...]``
    （OpenAI 兼容视觉协议；data URL 由后端读取本地图片生成）。
    """
    if not message.images:
        return {"role": message.role, "content": message.content}
    content: list[dict[str, Any]] = [{"type": "text", "text": message.content}]
    content.extend(
        {"type": "image_url", "image_url": {"url": url}} for url in message.images
    )
    return {"role": message.role, "content": content}


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


def _extract_tool_deltas(raw: Any) -> list[ToolCallDelta]:
    """从流式 chunk 中取出工具调用分片（``delta.tool_calls`` 逐项搬运）。

    流式协议下同一次调用以多片到达：``id`` / ``name`` 通常只在首片给出、
    ``arguments``（JSON 字符串）逐片拼接——每个字段都可能缺省。本函数
    **只保真透传**（含 ``index``），不按 index 归组、不拼接 arguments：
    那是调用方（chat 管道）的职责，provider 层不做业务解释。

    一个 chunk 可含多个 tool_calls 项（并行调用），按序全部返回；
    无 ``choices`` / 无 ``delta`` / 无 ``tool_calls`` 时返回空列表。
    """
    choices = getattr(raw, "choices", None)
    if not choices:
        return []
    delta = getattr(choices[0], "delta", None)
    if delta is None:
        return []
    items = getattr(delta, "tool_calls", None)
    if not items:
        return []

    deltas: list[ToolCallDelta] = []
    for item in items:
        function = getattr(item, "function", None)
        index = getattr(item, "index", None)
        deltas.append(
            ToolCallDelta(
                index=index if index is not None else 0,
                id=getattr(item, "id", None),
                name=getattr(function, "name", None),
                arguments=getattr(function, "arguments", None),
            )
        )
    return deltas


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
        """流式对话：逐块产出正文增量与工具调用分片，结束后产出 ``Chunk(finished=True)``。

        失败时抛 LlmError（已翻译、已脱敏）；可经 opts 覆盖 temperature / max_tokens / model；
        ``tools``（list[dict]，OpenAI 协议格式——由调用方从 tools 域转换后传入，
        本域不 import 该域）非空时随请求发给模型，模型可能返回 tool_calls：
        分片以 ``Chunk.tool_delta`` 透传（与正文可同帧；模型可能只回 tool_calls
        不产出正文——解析层照样保真，兜底由调用方处理）。
        未配置服务（base_url 空）先抛 LLM_NOT_CONFIGURED——明确引导，不走网络层模糊错误。
        """
        base_url = self._require_base_url()
        key = self._resolve_key()
        tools = opts.pop("tools", None)
        request: dict[str, Any] = {
            "model": opts.pop("model", self._model),
            "messages": [_message_payload(m) for m in messages],
            "stream": True,
            "temperature": opts.pop("temperature", self._temperature),
            "max_tokens": opts.pop("max_tokens", self._max_tokens),
        }
        if tools:
            request["tools"] = tools
        try:
            client = self._open_client(key, base_url=base_url)
            async with client:  # 请求结束即关闭连接池
                stream = await client.chat.completions.create(**request)
                async for raw in stream:
                    text = _extract_content(raw)
                    tool_deltas = _extract_tool_deltas(raw)
                    if not text and not tool_deltas:
                        continue  # 心跳帧 / 纯 reasoning 帧：不出帧（与既往行为一致）
                    if tool_deltas:
                        # 首片工具分片与正文同帧携带；同一 chunk 的其余调用各出一帧
                        yield Chunk(text=text, tool_delta=tool_deltas[0])
                        for extra in tool_deltas[1:]:
                            yield Chunk(text="", tool_delta=extra)
                    else:
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
            base_url = self._require_base_url()
            key = self._resolve_key()
        except LlmError as exc:
            return False, exc.message
        try:
            client = self._open_client(key, base_url=base_url)
            async with client:
                await client.chat.completions.create(
                    model=self._model,
                    messages=[{"role": "user", "content": "ping"}],
                    max_tokens=16,
                )
        except openai.OpenAIError as exc:
            return False, _translate(exc, timeout=self._timeout).message
        return True, f"连接成功（model={self._model}）"

    async def probe(
        self,
        *,
        base_url: str | None = None,
        model: str | None = None,
        api_key: str | None = None,
    ) -> ProbeResult:
        """连通性探测（§3.2 test_llm → §3.3 llm_test_result）。

        - 最小 chat 请求（max_tokens=1）：验证鉴权与地址（HTTP 200 即连通；
          推理型模型思考吃 token 使正文为空——不是失败）；
        - 随后尽力 GET ``{base_url}/models`` 拉可用模型列表（供设置面板下拉）；
          网关不支持 / 拉取失败 → ``models=None``，**不影响 ok 结论**；
        - 失败时 message 说明具体原因（连不上 / 401 / 404 / 超时…），全程脱敏；
        - base_url / model / api_key 缺省用本实例配置（api_key 缺省走读取链——
          环境变量 > keyring > 兜底文件，见 shared.secrets）；
        - base_url 最终为空（本实例与入参都空）= 未配置：直接回引导文案，不发请求；
        - 探测专用短平快参数：超时 10s、不自动重试（结论尽快给到面板）。
        """
        target_url = (base_url or self._base_url).strip()
        target_model = (model or self._model).strip()
        if not target_url:
            return ProbeResult(ok=False, message=NOT_CONFIGURED_MESSAGE)
        try:
            key = (api_key or "").strip() or self._resolve_key()
            register_secret(key)
            client = self._open_client(
                key, base_url=target_url, timeout=PROBE_TIMEOUT, max_retries=0
            )
            async with client:
                ok, message = await self._probe_chat(client, target_model)
                models = await self._fetch_models(client)
                return ProbeResult(ok=ok, message=message, models=models)
        except LlmError as exc:
            return ProbeResult(ok=False, message=exc.message)
        except Exception as exc:  # 兜底：探测任何异常都给面板一个可读结论，不带明文
            return ProbeResult(ok=False, message=f"连接测试异常：{_safe_detail(exc)}")

    # ---------- 内部实现 ----------

    def _require_base_url(self) -> str:
        """解析 base_url；未配置（空）抛 LlmError(LLM_NOT_CONFIGURED)——首启引导。

        空是合法配置态（用户还没选服务商）：给出明确引导文案，
        而不是让 SDK 抛出网络层模糊错误。
        """
        url = self._base_url.strip()
        if not url:
            raise LlmError(LlmErrorCode.LLM_NOT_CONFIGURED, NOT_CONFIGURED_MESSAGE)
        return url

    async def _probe_chat(
        self, client: openai.AsyncOpenAI, model: str
    ) -> tuple[bool, str]:
        """最小 chat 请求（max_tokens=1）→ (是否连通, 说明)。"""
        try:
            await client.chat.completions.create(
                model=model,
                messages=[{"role": "user", "content": "ping"}],
                max_tokens=1,
            )
        except openai.OpenAIError as exc:
            return False, _translate(exc, timeout=PROBE_TIMEOUT).message
        return True, f"连接成功（model={model}）"

    async def _fetch_models(self, client: openai.AsyncOpenAI) -> list[str] | None:
        """GET {base_url}/models 拉可用模型列表；不支持 / 失败返回 None（不报错）。"""
        try:
            page = await client.models.list()
        except Exception:
            return None
        ids = [getattr(item, "id", None) for item in getattr(page, "data", None) or []]
        model_ids = [str(model_id) for model_id in ids if model_id]
        return model_ids or None

    def _resolve_key(self) -> str:
        """解析 API key；未配置抛 LlmError(LLM_NO_KEY)。已解析的 key 登记进脱敏集合。"""
        key = (self._key_provider() or "").strip()
        if not key:
            raise LlmError(LlmErrorCode.LLM_NO_KEY, "未配置 LLM API key，请在设置中填写后再试")
        register_secret(key)
        return key

    def _open_client(
        self,
        key: str,
        *,
        base_url: str | None = None,
        timeout: float | None = None,
        max_retries: int | None = None,
    ) -> openai.AsyncOpenAI:
        """创建一次性异步客户端（用完即关；密钥不作为构造参数以外的任何形式外泄）。

        探测（probe）场景可覆盖 base_url / timeout / max_retries。
        """
        return openai.AsyncOpenAI(
            base_url=base_url or self._base_url,
            api_key=key,
            timeout=self._timeout if timeout is None else timeout,
            max_retries=self._max_retries if max_retries is None else max_retries,
        )
