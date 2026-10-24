"""LLM 流消费与降级重放（首次请求 / 摘 tool_choice / 摘 tools）。"""

from __future__ import annotations

from typing import Any, Awaitable, Callable

from loguru import logger

from backend.application.chat_pipeline.tools import mark_tools_unsupported
from backend.modules.chat.emotion import EmotionTagParser, Part
from backend.modules.llm.provider import ChatMessage, LLMProvider
from backend.shared.errors import LlmError, LlmErrorCode


class StreamRunner:
    """消费一次（或降级重放）LLM 流，把正文/情绪/工具分片交给流水线。

    ``emit``：把 EmotionTagParser 产出的 parts 推给 sink 并返回本批最后情绪；
    ``reasoning``：推理增量出站。
    """

    def __init__(
        self,
        provider: LLMProvider,
        *,
        parser: EmotionTagParser,
        clean_parts: list[str],
        tool_acc: dict[int, dict[str, Any]],
        emit: Callable[[list[Part]], Awaitable[str | None]],
        reasoning: Callable[[str], Awaitable[None]],
    ) -> None:
        self._provider = provider
        self._parser = parser
        self._clean_parts = clean_parts
        self._tool_acc = tool_acc
        self._emit = emit
        self._reasoning = reasoning

    async def consume(self, messages: list[ChatMessage], **opts: Any) -> str | None:
        """消费一次流；返回本轮最后出现的合法情绪（无则 None）。"""
        last_emotion: str | None = None
        async for chunk in self._provider.stream_chat(messages, **opts):
            if chunk.reasoning:
                await self._reasoning(chunk.reasoning)
            if chunk.text:
                emotion = await self._emit(self._parser.feed(chunk.text))
                if emotion is not None:
                    last_emotion = emotion
            delta = chunk.tool_delta
            if delta is not None:
                # 按 index 归组：id/name 通常只在首片，arguments 逐片拼接
                acc = self._tool_acc.setdefault(
                    delta.index, {"id": None, "name": None, "arguments": ""}
                )
                if delta.id:
                    acc["id"] = delta.id
                if delta.name:
                    acc["name"] = delta.name
                if delta.arguments:
                    acc["arguments"] += delta.arguments
        return last_emotion

    async def consume_with_fallback(
        self,
        messages: list[ChatMessage],
        request_opts: dict[str, Any],
        *,
        use_tools: bool,
    ) -> LlmError | None:
        """首次请求 + 降级重放，返回最终失败（成功返回 None）。

        降级顺序：
        1. LLM_BAD_REQUEST 且本轮无产出：先摘 ``tool_choice`` 保留 tools；
        2. 仍被拒：置进程级标记、摘除 tools 重放；
        3. 重放再败：以第一次错误收尾（对用户更有指向性）。
        """
        first_error: LlmError | None = None
        try:
            await self.consume(messages, **request_opts)
            return None
        except LlmError as first:
            first_error = first
            error = first

        if not (
            use_tools
            and error.code == LlmErrorCode.LLM_BAD_REQUEST
            and not self._clean_parts
            and not self._tool_acc
        ):
            return error
        if "tool_choice" in request_opts:
            logger.warning(
                "tool_choice 被拒（{}），摘除后保留 tools 重试：{}",
                error.code,
                error.message,
            )
            request_opts.pop("tool_choice", None)
            try:
                await self.consume(messages, **request_opts)
                return None
            except LlmError as retry_exc:
                if not (
                    retry_exc.code == LlmErrorCode.LLM_BAD_REQUEST
                    and not self._clean_parts
                    and not self._tool_acc
                ):
                    return retry_exc
                error = retry_exc
        logger.warning(
            "工具请求被拒（{}），疑似网关/模型不支持 tools；摘除 tools 重放本轮：{}",
            error.code,
            error.message,
        )
        mark_tools_unsupported()
        request_opts.pop("tools", None)
        try:
            await self.consume(messages, **request_opts)
            return None
        except LlmError as retry_exc:
            logger.warning(
                "摘除 tools 重放仍失败（{}）：{}",
                retry_exc.code,
                retry_exc.message,
            )
            return first_error
