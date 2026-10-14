"""对话流水线（P1 Echo 版）。

一轮对话的用户可见事件流，严格按设计文档 §7.1 时序编排：

    user_message
      → state:thinking → reply_start → token / emotion（流式）
      → reply_end → state:idle

- 与 WS 协议解耦：通过出站端口 ReplySink 输出，由 interfaces/ws 实现并转成协议事件；
- 情绪标签解析交给 modules/chat/emotion（跨片段切分安全）；
- 接入真实 LLM 时只需注入实现了 modules.llm.provider.LLMProvider 的实现，
  EchoLLMProvider 是 P1 阶段的替身（真 provider 接入后移除）。

注：sentence 事件（§3.3）供 Phase 2 TTS 使用，本期流水线不推送。
"""

from __future__ import annotations

import asyncio
import uuid
from typing import AsyncIterator, Protocol, Sequence

from loguru import logger

from backend.modules.chat.emotion import (
    EMOTION_VALUES,
    EmotionPart,
    EmotionTagParser,
    Part,
    TextPart,
)
from backend.modules.llm.provider import ChatMessage, Chunk

# —— P1 Echo 替身（真 LLM provider 接入后移除）——

# 固定测试回复：与 ECHO_CHUNK_SIZE=4 配合时，第一个标签 <emo:happy> 会被切成
# "。<em" + "o:ha" + "ppy>" 三个片段 —— 故意覆盖「标签跨片段」边界（§10 风险 #5）。
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
    """P1 阶段的 LLM 替身：按固定分片流式吐出预设回复。"""

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
        self, messages: Sequence[ChatMessage], **opts: object
    ) -> AsyncIterator[Chunk]:
        """忽略入参，按固定分片流式返回预设回复。"""
        for piece in split_chunks(self._reply, self._chunk_size):
            if self._delay:
                await asyncio.sleep(self._delay)
            yield Chunk(text=piece)
        yield Chunk(text="", finished=True)


class ReplySink(Protocol):
    """对话流水线的出站端口（依赖倒置：由 interfaces 层实现为 WS 事件）。"""

    async def state(self, state: str) -> None: ...

    async def reply_start(self, message_id: str) -> None: ...

    async def token(self, message_id: str, text: str) -> None: ...

    async def emotion(self, message_id: str, emotion: str, intensity: float) -> None: ...

    async def reply_end(
        self, message_id: str, full_text: str, *, interrupted: bool = False
    ) -> None: ...


class ChatPipeline:
    """一轮对话的编排器。"""

    def __init__(self, provider: object) -> None:
        # provider 只需满足 LLMProvider 协议（P1 为 EchoLLMProvider）
        self._provider = provider

    async def run_turn(self, sink: ReplySink, *, session_id: str, user_text: str) -> None:
        """执行一轮对话；被取消（interrupt / 新消息抢占）时按 §7.2 收尾。

        该协程由 interfaces 层以后台任务方式运行，运行期间消息循环保持可用。
        """
        message_id = f"m_{uuid.uuid4().hex}"
        parser = EmotionTagParser()
        clean_parts: list[str] = []
        reply_started = False
        try:
            await sink.state("thinking")
            await sink.reply_start(message_id)
            reply_started = True

            # TODO(接真 LLM)：此处接入 chat/history 落库 + memory 检索 + context 组装，
            # 再由注入的 LLMProvider.stream_chat 发起真实流式请求。
            messages = [ChatMessage(role="user", content=user_text)]
            async for chunk in self._provider.stream_chat(messages):  # type: ignore[attr-defined]
                if chunk.text:
                    await self._emit(sink, message_id, parser.feed(chunk.text), clean_parts)

            await self._emit(sink, message_id, parser.flush(), clean_parts)

            full_text = "".join(clean_parts)
            await sink.reply_end(message_id, full_text)
            await sink.state("idle")
        except asyncio.CancelledError:
            if reply_started:
                # 被打断：以已产出的文本收尾，前端据此停止播放并回 idle
                try:
                    await sink.reply_end(message_id, "".join(clean_parts), interrupted=True)
                    await sink.state("idle")
                except Exception:  # 连接可能已断开，收尾失败不影响取消语义
                    logger.debug("中断收尾事件发送失败（连接可能已断开）")
            raise
        finally:
            logger.debug("对话结束 session={} message_id={}", session_id, message_id)

    @staticmethod
    async def _emit(
        sink: ReplySink, message_id: str, parts: list[Part], clean_parts: list[str]
    ) -> None:
        """按顺序推送解析结果（顺序保真）：文本 → token，情绪 → emotion。"""
        for part in parts:
            if isinstance(part, TextPart):
                clean_parts.append(part.text)
                await sink.token(message_id, part.text)
            elif isinstance(part, EmotionPart):
                if part.emotion in EMOTION_VALUES:
                    await sink.emotion(message_id, part.emotion, 1.0)
                else:
                    # 白名单外的标签已剥离，不向前端推送未知情绪
                    logger.warning("忽略 v1 情绪集合外的标签：<emo:{}>", part.emotion)
