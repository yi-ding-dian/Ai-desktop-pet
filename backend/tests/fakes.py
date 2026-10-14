"""测试替身（LLMProvider 的假实现）。

- EchoLLMProvider：固定回复 + 固定分片。第一个情绪标签会被"故意"切在
  分片中间（跨片段解析验证，§10 风险 #5）；从 chat_pipeline 迁入（生产路径
  已改用 OpenAICompatProvider，本替身仅供测试）。
- ScriptedProvider：可编程替身。按脚本产出片段，可选在流开始前 / 结束后
  抛 LlmError，并记录每次收到的 messages（供上下文组装断言）。
"""

from __future__ import annotations

import asyncio
from typing import Any, AsyncIterator, Sequence

from backend.modules.llm.provider import ChatMessage, Chunk
from backend.shared.errors import LlmError

# —— Echo：固定回复替身 ——

# 与 ECHO_CHUNK_SIZE=4 配合时，第一个标签 <emo:happy> 会被切成
# "。<em" + "o:ha" + "ppy>" 三个片段 —— 故意覆盖「标签跨片段」边界。
ECHO_REPLY = (
    "你好呀！我是小豆。<emo:happy>今天过得怎么样？"
    "<emo:thinking>唔……让我想想。<emo:neutral>我随时都在这里陪你哦。"
)
ECHO_CHUNK_SIZE = 4
ECHO_CHUNK_DELAY = 0.02  # 模拟流式节奏（秒）


def split_chunks(text: str, size: int = ECHO_CHUNK_SIZE) -> list[str]:
    """把文本按固定长度切成流式片段（模拟 LLM 的任意切分边界）。"""
    return [text[i : i + size] for i in range(0, len(text), size)]


class EchoLLMProvider:
    """固定回复替身：按固定分片流式吐出预设回复，忽略入参。"""

    def __init__(
        self,
        reply: str = ECHO_REPLY,
        chunk_size: int = ECHO_CHUNK_SIZE,
        delay: float = ECHO_CHUNK_DELAY,
    ) -> None:
        self._reply = reply
        self._chunk_size = chunk_size
        self._delay = delay

    async def stream_chat(
        self, messages: Sequence[ChatMessage], **opts: Any
    ) -> AsyncIterator[Chunk]:
        for piece in split_chunks(self._reply, self._chunk_size):
            if self._delay:
                await asyncio.sleep(self._delay)
            yield Chunk(text=piece)
        yield Chunk(text="", finished=True)


# —— Scripted：可编程替身 ——


class ScriptedProvider:
    """按脚本流式产出；可注入错误、记录收到的 messages。

    - pieces：逐片段产出的文本；
    - delay：片段间隔（模拟流式节奏，供中断测试）；
    - start_error：迭代开始前抛出（模拟鉴权/连接失败，零产出）；
    - mid_error：pieces 之后抛出（模拟流中途断流）。
    """

    def __init__(
        self,
        pieces: Sequence[str] = (),
        *,
        delay: float = 0.0,
        start_error: LlmError | None = None,
        mid_error: LlmError | None = None,
    ) -> None:
        self._pieces = list(pieces)
        self._delay = delay
        self._start_error = start_error
        self._mid_error = mid_error
        self.seen_messages: list[list[ChatMessage]] = []

    async def stream_chat(
        self, messages: Sequence[ChatMessage], **opts: Any
    ) -> AsyncIterator[Chunk]:
        self.seen_messages.append(list(messages))
        if self._start_error is not None:
            raise self._start_error
        for piece in self._pieces:
            if self._delay:
                await asyncio.sleep(self._delay)
            yield Chunk(text=piece)
        if self._mid_error is not None:
            raise self._mid_error
        yield Chunk(text="", finished=True)
