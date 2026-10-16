"""测试替身（LLMProvider / TTSProvider 的假实现）。

- EchoLLMProvider：固定回复 + 固定分片。第一个情绪标签会被"故意"切在
  分片中间（跨片段解析验证，§10 风险 #5）；从 chat_pipeline 迁入（生产路径
  已改用 OpenAICompatProvider，本替身仅供测试）。
- ScriptedProvider：可编程替身。按脚本产出片段，可选在流开始前 / 结束后
  抛 LlmError，并记录每次收到的 messages（供上下文组装断言）。
- FakeLLMProvider：带工具能力的可编程替身（文本分片 + tool_delta 分片、
  记录 opts）——供 chat 管道"工具机制"（§4.7）测试；ScriptedProvider 的
  纯文本用法保持不变。
- FakeTTSProvider：可编程 TTS 替身（记录合成文本、可注入延迟/失败）。
"""

from __future__ import annotations

import asyncio
from typing import Any, AsyncIterator, Sequence

from backend.modules.llm.provider import ChatMessage, Chunk, ToolCallDelta
from backend.shared.errors import LlmError, TtsError, TtsErrorCode

# —— Echo：固定回复替身 ——

# 与 ECHO_CHUNK_SIZE=4 配合时，第一个标签 <emo:happy> 会被切成
# "。<em" + "o:ha" + "ppy>" 三个片段 —— 故意覆盖「标签跨片段」边界。
ECHO_REPLY = (
    "你好呀！我是小兔。<emo:happy>今天过得怎么样？"
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


# —— FakeLLM：带工具能力的可编程替身（管道工具回调测试用） ——


class FakeLLMProvider:
    """可编程替身：正文分片 + 工具调用分片（§4.7 工具机制测试用）。

    - pieces：正文分片（按序产出 ``Chunk(text=piece)``）；
    - tool_deltas：工具调用分片（正文之后按序产出 ``Chunk(text="", tool_delta=...)``；
      模拟"模型只回 tool_calls、不产出正文"时 pieces 传空即可）；
    - delay：分片间隔（模拟流式节奏）；
    - start_error / mid_error：与 ScriptedProvider 同义（流前 / 流后抛错）；
    - fail_calls：指定"第 n 次调用（1-based）开始前抛出对应错误"（与
      FakeTTSProvider.fail_calls 同语义）——模拟"首轮失败、重放成功"的工具降级场景；
    - seen_messages / seen_opts：记录每次调用的 messages 与 opts——断言
      "tools 参数是否透传到 provider"用（其余用法与 ScriptedProvider 一致，
      本替身不替代它，纯文本场景继续用 ScriptedProvider）。
    """

    def __init__(
        self,
        pieces: Sequence[str] = (),
        *,
        tool_deltas: Sequence[ToolCallDelta] = (),
        delay: float = 0.0,
        start_error: LlmError | None = None,
        mid_error: LlmError | None = None,
        fail_calls: dict[int, LlmError] | None = None,
    ) -> None:
        self._pieces = list(pieces)
        self._tool_deltas = list(tool_deltas)
        self._delay = delay
        self._start_error = start_error
        self._mid_error = mid_error
        self._fail_calls = fail_calls or {}
        self.seen_messages: list[list[ChatMessage]] = []
        self.seen_opts: list[dict[str, Any]] = []

    async def stream_chat(
        self, messages: Sequence[ChatMessage], **opts: Any
    ) -> AsyncIterator[Chunk]:
        self.seen_messages.append(list(messages))
        self.seen_opts.append(dict(opts))
        call_error = self._fail_calls.get(len(self.seen_opts))
        if call_error is not None:
            raise call_error
        if self._start_error is not None:
            raise self._start_error
        for piece in self._pieces:
            if self._delay:
                await asyncio.sleep(self._delay)
            yield Chunk(text=piece)
        for delta in self._tool_deltas:
            if self._delay:
                await asyncio.sleep(self._delay)
            yield Chunk(text="", tool_delta=delta)
        if self._mid_error is not None:
            raise self._mid_error
        yield Chunk(text="", finished=True)


# —— TTS 替身 ——

#: 假 mp3 载荷（头部用 MPEG 帧同步字节，仅校验字节搬运，不要求可播放）
FAKE_MP3 = b"\xff\xf3\x64\xc4" + b"\x00" * 124


class FakeTTSProvider:
    """可编程 TTS 替身。

    - audio：成功时返回的假音频字节；
    - delay：每次合成耗时（模拟真实合成节奏，供取消 / 超时测试）；
    - fail_calls：指定"第 n 次调用（1-based）失败"（其余成功）；
    - fail_always：每次调用都失败；
    - calls：已收到的合成文本（按序，供保序 / 跳过断言）。
    """

    def __init__(
        self,
        *,
        audio: bytes = FAKE_MP3,
        delay: float = 0.0,
        fail_calls: set[int] | None = None,
        fail_always: bool = False,
    ) -> None:
        self._audio = audio
        self._delay = delay
        self._fail_calls = fail_calls or set()
        self._fail_always = fail_always
        self.calls: list[str] = []

    async def synthesize(self, text: str) -> bytes:
        self.calls.append(text)
        call_no = len(self.calls)
        if self._delay:
            await asyncio.sleep(self._delay)
        if self._fail_always or call_no in self._fail_calls:
            raise TtsError(TtsErrorCode.TTS_NETWORK, "模拟合成失败（测试）")
        return self._audio
