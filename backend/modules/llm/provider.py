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
    """一轮对话消息。role: system / user / assistant。"""

    role: str
    content: str


@dataclass(frozen=True)
class Chunk:
    """流式返回的增量片段。finished=True 表示流结束。"""

    text: str
    finished: bool = False


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
