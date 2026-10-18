"""LLM provider 抽象接口（设计文档 §4.1）。

Protocol 与数据类型定义；真实实现在 ``openai_compat.py``
（OpenAI 兼容协议，覆盖 DeepSeek/智谱/通义/Moonshot/本地网关等）。
测试替身见 ``tests/fakes.py``。
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, AsyncIterator, Protocol, Sequence


@dataclass(frozen=True)
class ChatMessage:
    """一轮对话消息。role: system / user / assistant / tool。

    ``images``（可选，文件分析 P1 多模态）：data URL 列表；只有当前用户消息可能携带，
    历史消息不带（图片正文不落库、不跨轮重发）。provider 据此把 content 组装成
    OpenAI 多模态数组（text + image_url），无图片时保持纯字符串（协议兼容）。

    ``tool_calls`` / ``tool_call_id``（2026-10-18 联网搜索结果回传）：
    - assistant 消息携带模型的工具调用声明（OpenAI ``tool_calls`` 数组）；
    - tool 消息携带对应调用的结果，``tool_call_id`` 必须与声明中的 id 一致。
    普通对话消息两者均为空，行为与旧版逐字段一致。
    """

    role: str
    content: str
    images: tuple[str, ...] = ()
    tool_calls: tuple[dict[str, Any], ...] = ()
    tool_call_id: str | None = None


@dataclass(frozen=True)
class ToolCallDelta:
    """流式工具调用分片（OpenAI 协议 ``delta.tool_calls`` 的单项，§4.7 工具机制）。

    同一次工具调用以多片到达：``id`` / ``name`` 通常只在首片出现，
    ``arguments``（JSON 字符串）逐片拼接；调用方按 ``index`` 归组后解析。
    """

    index: int
    id: str | None = None
    name: str | None = None
    arguments: str | None = None


@dataclass(frozen=True)
class Chunk:
    """流式返回的增量片段。finished=True 表示流结束。

    ``tool_delta``：工具调用分片（provider 收到时携带，与 ``text`` 可同帧共存；
    未携带工具调用能力的 provider / 请求不带 tools 时恒为 None）。
    """

    text: str
    finished: bool = False
    tool_delta: ToolCallDelta | None = None


@dataclass(frozen=True)
class ProbeResult:
    """连通性探测结果（设置面板「测试连接」→ §3.3 llm_test_result 的数据来源）。

    - ``ok``：最小 chat 请求是否成功（HTTP 200 即连通）；
    - ``message``：成功说明 / 失败的具体原因（连不上、401、404、超时…），已脱敏；
    - ``models``：/models 拉到的可用模型列表；拉不到为 None（不视为失败）。
    """

    ok: bool
    message: str
    models: list[str] | None = None


class LLMProvider(Protocol):
    """LLM 服务商统一抽象（BYOK：base_url + key + model 由实现层管理）。"""

    def stream_chat(
        self, messages: Sequence[ChatMessage], **opts: Any
    ) -> AsyncIterator[Chunk]:
        """流式对话：逐块产出增量文本。"""
        ...

    async def embed(self, texts: Sequence[str]) -> list[list[float]]:
        """文本向量化（记忆检索用）。"""
        ...

    async def test(self) -> tuple[bool, str]:
        """连接测试（设置面板「测试连接」）：返回 (是否成功, 说明)。"""
        ...

    async def probe(self, **overrides: Any) -> ProbeResult:
        """连通性探测：最小请求 + 尽力拉模型列表（参数可覆盖 base_url/model/key）。"""
        ...
