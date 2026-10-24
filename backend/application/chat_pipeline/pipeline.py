"""一轮对话的编排：事件流、工具调用、文件分析、语音与搜索续写。

模块 docstring（时序、工具三层保底、搜索 feedback、失败/打断语义）见
``backend/application/chat_pipeline/__init__.py``。
"""

from __future__ import annotations

import asyncio
import json
import time
import uuid
from typing import TYPE_CHECKING, Any, Callable, Sequence

from loguru import logger

from backend.application.chat_pipeline.emitter import emit_parts, send_notice
from backend.application.chat_pipeline.prompts import (
    TEACHING_HINT,
    PromptBuilder,
    insert_system_hints,
    is_speakable,
    stored_user_text,
)
from backend.application.chat_pipeline.stream import StreamRunner
from backend.application.chat_pipeline.tools import (
    FALLBACK_ACK,
    collect_tool_calls,
    compose_tool_ack,
    execute_tool_calls,
    forced_tool_missed_notice,
    match_directive_spec,
    select_tool_defs,
    tools_unsupported,
)
from backend.application.chat_pipeline.types import ReplySink, TurnOptions
from backend.application.session import Session
from backend.modules.chat.emotion import EmotionTagParser, Part
from backend.modules.files import (
    FileRejected,
    FileRef,
    build_attachment_block,
    build_attachment_user_content,
    estimate_messages_tokens,
    read_attachments,
)
from backend.modules.llm.provider import ChatMessage, LLMProvider
from backend.modules.tools import ToolRegistry, ToolSpec, match_forced_tool
from backend.modules.voice.splitter import SentenceSplitter
from backend.shared.errors import LlmError

if TYPE_CHECKING:  # 仅类型注解；运行时经 Protocol/鸭子类型协作（避免循环 import）
    from backend.application.memory_book_service import MemoryBookService
    from backend.application.voice import ReplyVoice, VoiceOut
    from backend.modules.memory.profile import ProfileStore
    from backend.modules.memory.store import MemoryStore
    from backend.shared.config import AppConfig


class ChatPipeline:
    """一轮对话的编排器。

    ``memories`` / ``profile``（可选注入，P3 记忆）：缺省 None 时行为与
    P1/P2 完全一致；装配后每轮组装第二条 system（画像 + 召回记忆）。

    ``pet_name``（可选注入，§7.6.3）：读当前 ``pet.name`` 配置的回调。

    ``tools``（可选注入，§4.7 工具机制）：内置工具注册表；缺省 None 时
    不做指令快通道、请求不携带 tools。

    ``memory_book``（可选注入，2026-10-18 记忆本）：每轮注入"名字 + 类型"清单。
    """

    def __init__(
        self,
        provider: LLMProvider,
        *,
        memories: MemoryStore | None = None,
        profile: ProfileStore | None = None,
        pet_name: Callable[[], str | None] | None = None,
        tools: ToolRegistry | None = None,
        memory_book: MemoryBookService | None = None,
        config: Callable[[], AppConfig] | None = None,
    ) -> None:
        self._provider = provider
        self._tools = tools
        # 提示词/记忆/限额的组装全部下沉到 PromptBuilder（每轮动态读取活配置）
        self._prompts = PromptBuilder(
            memories=memories,
            profile=profile,
            pet_name=pet_name,
            memory_book=memory_book,
            tools=tools,
            config=config,
        )

    async def run_turn(
        self,
        sink: ReplySink,
        *,
        session: Session,
        user_text: str,
        voice: VoiceOut | None = None,
        attachments: Sequence[FileRef] | None = None,
        options: TurnOptions | None = None,
        client_id: str | None = None,
    ) -> None:
        """执行一轮对话；被取消（interrupt / 新消息抢占）时按 §7.2 收尾。"""
        message_id = f"m_{uuid.uuid4().hex}"
        # 回复开始时间：助手消息落库时用它作 created_at，保证实时与历史回填的时间一致
        reply_created_at = int(time.time() * 1000)
        # 工作模式单轮选项（None = 旧行为：允许搜索、普通回复）
        search = True if options is None else options.search
        teaching = bool(options is not None and options.teaching)
        parser = EmotionTagParser()
        clean_parts: list[str] = []
        emotion_seen = False
        last_emotion: str | None = None  # 本轮最后出现的情绪（随 assistant 消息落库）
        reply_started = False
        llm_error: LlmError | None = None
        # 工具机制（§4.7）：本轮待派发的调用 [(tool_id, name, args)]；tool_acc 为分片归组
        tool_calls_to_emit: list[tuple[str, str, dict[str, Any]]] = []
        tool_acc: dict[int, dict[str, Any]] = {}
        #: 本轮强制指定的工具（match_forced_tool；仅提醒意图），用于失败兜底与日志
        forced_tool: str | None = None
        #: 强制工具未真正返回（网关忽略 tool_choice）——回复后给用户一条警示 notice
        forced_tool_missed = False

        # 语音链路（仅装配且未降级时启用）：干净文本 → splitter 切句 →
        # sentence 事件 + TTS 串行队列（合成完推二进制帧，§3.5）
        splitter: SentenceSplitter | None = None
        voice_reply: ReplyVoice | None = None
        if voice is not None and voice.available:
            splitter = SentenceSplitter()
            voice_reply = voice.open_reply(sink, message_id)
        sentence_seq = 0

        async def emit_sentences(sentences: list[str]) -> None:
            """完整句 → 推 sentence 事件并交给 TTS 合成。"""
            nonlocal sentence_seq
            if voice_reply is None:
                return
            for text in sentences:
                if not voice_reply.enabled:
                    return  # 运行中 TTS 被停用：不再推 sentence
                if not is_speakable(text):
                    continue  # 纯标点 / 空白 / emoji：无可发音内容，跳过
                await sink.sentence(message_id, sentence_seq, text)
                voice_reply.push(sentence_seq, text)
                sentence_seq += 1

        async def on_clean_text(text: str) -> None:
            """LLM 输出的干净文本（已剥离情绪标签）→ 喂给分句器。"""
            if splitter is not None:
                await emit_sentences(splitter.feed(text))

        async def emit_and_track(parts: list[Part]) -> str | None:
            """推送解析结果，并更新本轮最后情绪（供落库）。"""
            nonlocal emotion_seen, last_emotion
            emotion = await emit_parts(
                sink, message_id, parts, clean_parts, on_clean_text=on_clean_text
            )
            if emotion is not None:
                emotion_seen = True
                last_emotion = emotion
            return emotion

        # ---- 文件分析（P1）：附件在调 LLM 前读取/限额；正文只注入本轮、不落库 ----
        file_refs = list(attachments or [])
        # 历史里只存文件名（不含正文）：下一轮不会重复把整个文件送给模型
        stored_text = stored_user_text(user_text, file_refs) if file_refs else user_text
        llm_messages: list[ChatMessage] | None = None
        #: 正常 LLM 路径的完整消息列表；联网搜索/抓取的续写轮需要它作为底座。
        messages: list[ChatMessage] | None = None

        async def save_message(
            role: str,
            content: str,
            *,
            emotion: str | None = None,
            saved_client_id: str = "",
            created_at: int | None = None,
        ) -> None:
            """落库并把 DB 行 id 回给前端（工作模式按 id 删除单条消息）。"""
            db_id = session.append_message(
                role, content, emotion=emotion, created_at=created_at
            )
            if db_id is not None:
                saved = getattr(sink, "message_saved", None)
                if saved is not None:
                    await saved(saved_client_id, db_id, role)

        async def reject_with(text: str) -> None:
            """本地拒绝（不调 LLM）：用户消息照常落库，回复走气泡事件流。"""
            nonlocal reply_started, emotion_seen, last_emotion
            await save_message("user", stored_text, saved_client_id=client_id or "")
            await sink.reply_start(message_id)
            reply_started = True
            clean_parts.append(text)
            await sink.token(message_id, text)
            emotion_seen = True
            last_emotion = "sad"
            await sink.emotion(message_id, "sad", 1.0)
            await save_message(
                "assistant",
                text,
                emotion="sad",
                saved_client_id=message_id,
                created_at=reply_created_at,
            )
            await sink.reply_end(message_id, text)
            await sink.state("idle")

        # 快通道判定（§4.7，仅装配注册表时）；带附件时不走快通道
        directive_spec: ToolSpec | None = None
        if self._tools is not None and not file_refs:
            directive_spec = match_directive_spec(self._tools, user_text)

        try:
            await sink.state("thinking")  # 必须在发起请求前（见包 docstring）

            if file_refs:
                limits = self._prompts.file_limits()
                try:
                    prepared = await asyncio.to_thread(read_attachments, file_refs, limits)
                except FileRejected as exc:
                    await reject_with(exc.message)
                    return

                text_files = [item for item in prepared if not item.is_image]
                image_files = [item for item in prepared if item.is_image]
                block = build_attachment_block(text_files)
                content = build_attachment_user_content(
                    user_text, block, image_names=[item.name for item in image_files]
                )
                images = tuple(
                    item.image_url for item in image_files if item.image_url is not None
                )
                memory_block = await self._prompts.build_memory_block(user_text)
                history = session.recent_messages()  # 当前用户消息尚未 append
                candidate = self._prompts.compose_messages(
                    memory_block, history, content, images=images, search=search
                )
                budget = self._prompts.context_budget()
                if estimate_messages_tokens(candidate) > budget:
                    without_history = self._prompts.compose_messages(
                        memory_block, [], content, images=images, search=search
                    )
                    required = estimate_messages_tokens(without_history)
                    if required > budget:
                        # 丢历史也放不下：拒绝整轮（不丢历史——本轮没有被处理）
                        await reject_with(
                            f"这批附件加问题约需 {required:,} tokens，"
                            f"超过本轮可用上下文预算 {budget:,} tokens～"
                            "可以换个小文件/图片，或在设置 → 文件里调高上下文预算。"
                        )
                        return
                    dropped = session.drop_context()
                    if dropped:
                        await send_notice(
                            sink,
                            "context_reset",
                            "为了装下这批附件，本轮先不带之前的聊天记录；"
                            "历史消息还在，随时可以回看。",
                        )
                    candidate = without_history
                llm_messages = candidate
                logger.info(
                    "文件分析：{} 个附件（图片 {} 张）/ 文本 {} 字（估算 {} tokens，预算 {}）",
                    len(prepared),
                    len(image_files),
                    sum(a.chars for a in text_files),
                    estimate_messages_tokens(candidate),
                    budget,
                )

            await save_message("user", stored_text, saved_client_id=client_id or "")
            await sink.reply_start(message_id)
            reply_started = True

            if directive_spec is not None:
                # 快通道：本地 ack 走正常事件流（token / 分句 / 落库与模型路径一致）
                ack_text = directive_spec.ack or FALLBACK_ACK
                clean_parts.append(ack_text)
                await sink.token(message_id, ack_text)
                await on_clean_text(ack_text)  # 同时喂分句器（TTS 能播报）
                emotion_seen = True
                last_emotion = "happy"
                await sink.emotion(message_id, "happy", 1.0)
                # tool_id 前缀 dir_：区分"指令来源"（vs 模型调用自带的 call id）
                tool_calls_to_emit.append(
                    (f"dir_{uuid.uuid4().hex[:8]}", directive_spec.name, {})
                )
            else:
                # —— 正常 LLM 流（携带 tools，除非进程级降级标记已置位）——
                messages = (
                    llm_messages
                    if llm_messages is not None
                    else await self._prompts.build_messages(
                        session, user_text=user_text, search=search
                    )
                )
                use_tools = self._tools is not None and not tools_unsupported()
                # 提醒意图（动作 + 明确时间）强制 tool_choice
                if use_tools and self._tools is not None:
                    candidate_name = match_forced_tool(user_text)
                    if (
                        candidate_name is not None
                        and self._tools.get(candidate_name) is not None
                    ):
                        forced_tool = candidate_name
                request_opts: dict[str, Any] = {}
                if use_tools and self._tools is not None:
                    tool_defs = select_tool_defs(self._tools, search=search)
                    if tool_defs:
                        request_opts["tools"] = tool_defs
                    if forced_tool is not None:
                        request_opts["tool_choice"] = {
                            "type": "function",
                            "function": {"name": forced_tool},
                        }
                        logger.info("意图明确，强制调用工具：{}", forced_tool)

                # 教学模式：临时提示（不落库、不进历史）。
                # 智能搜索不再额外加提示：工具清单本身已按本轮开关生成，
                # 每轮多一段“已开启搜索”的说明只是重复（2026-10-24 清理）。
                extra_system: list[str] = []
                if teaching:
                    extra_system.append(TEACHING_HINT)
                messages = insert_system_hints(messages, extra_system)

                runner = StreamRunner(
                    self._provider,
                    parser=parser,
                    clean_parts=clean_parts,
                    tool_acc=tool_acc,
                    emit=emit_and_track,
                    reasoning=lambda text: sink.reasoning(message_id, text),
                )
                llm_error = await runner.consume_with_fallback(
                    messages, request_opts, use_tools=use_tools
                )
                if llm_error is not None:
                    # 失败已业务化、已脱敏；先把缓冲收尾，再统一走失败收尾（下方）
                    logger.warning(
                        "LLM 请求失败（{}）：{}", llm_error.code, llm_error.message
                    )

            # 流结束（含失败）：残留半标签按普通文本吐出（§4.2）
            await emit_and_track(parser.flush())

            # 工具调用收口（§4.7）：解析模型分片（快通道已预置，此处为空操作）。
            tool_calls_to_emit.extend(collect_tool_calls(tool_acc))
            forced_tool_missed = forced_tool is not None and not any(
                name == forced_tool for _, name, _ in tool_calls_to_emit
            )
            if forced_tool_missed:
                logger.warning(
                    "已强制 tool_choice={}，但模型仍未返回该工具调用", forced_tool
                )
            # 执行方分流：backend 型工具在 reply_end 前执行，结果稍后以 notice 推送
            frontend_calls, backend_results = await execute_tool_calls(
                self._tools, tool_calls_to_emit, user_text
            )
            if (frontend_calls or backend_results) and not clean_parts:
                ack_text = compose_tool_ack(self._tools, frontend_calls, backend_results)
                clean_parts.append(ack_text)
                await sink.token(message_id, ack_text)
                await on_clean_text(ack_text)

            # 搜索来源结构化回传（工作窗引用悬浮卡片用；正文里只有 [n] 角标）
            source_items: list[dict[str, Any]] = []
            for _tool_name, result in backend_results:
                items = result.get("sources")
                if isinstance(items, list):
                    source_items.extend(
                        item
                        for item in items
                        if isinstance(item, dict) and item.get("url")
                    )
            if source_items:
                deduped_sources: list[dict[str, Any]] = []
                seen_urls: set[str] = set()
                for item in source_items:
                    url_text = str(item.get("url", "")).strip()
                    if not url_text or url_text in seen_urls:
                        continue
                    seen_urls.add(url_text)
                    deduped_sources.append(item)
                sender = getattr(sink, "sources", None)
                if sender is not None:
                    try:
                        await sender(message_id, deduped_sources)
                    except Exception:
                        logger.debug("来源信息发送失败（忽略）")

            # ---- 联网搜索/抓取：工具结果回喂模型，再生成一轮最终回答 ----
            feedback_items = [
                (name, result)
                for name, result in backend_results
                if isinstance(result.get("model_content"), str)
                and result.get("model_content")
            ]
            if feedback_items and messages is not None and llm_error is None:
                assistant_calls: list[dict[str, Any]] = []
                tool_messages: list[ChatMessage] = []
                for tool_name, result in feedback_items:
                    call_id = str(
                        result.get("_tool_call_id") or f"call_{uuid.uuid4().hex[:8]}"
                    )
                    call_args = result.get("_tool_args")
                    if not isinstance(call_args, dict):
                        call_args = {}
                    assistant_calls.append(
                        {
                            "id": call_id,
                            "type": "function",
                            "function": {
                                "name": tool_name,
                                "arguments": json.dumps(call_args, ensure_ascii=False),
                            },
                        }
                    )
                    tool_messages.append(
                        ChatMessage(
                            role="tool",
                            content=str(result["model_content"]),
                            tool_call_id=call_id,
                        )
                    )
                follow_up = list(messages)
                follow_up.append(
                    ChatMessage(
                        role="assistant",
                        content="".join(clean_parts),
                        tool_calls=tuple(assistant_calls),
                    )
                )
                follow_up.extend(tool_messages)
                logger.info(
                    "联网搜索/抓取结果回传：{} 个工具调用，开始第二轮生成",
                    len(feedback_items),
                )
                # 第二轮不带 tools。
                follow_up_opts: dict[str, Any] = {}
                try:
                    async for chunk in self._provider.stream_chat(
                        follow_up, **follow_up_opts
                    ):
                        if chunk.reasoning:
                            await sink.reasoning(message_id, chunk.reasoning)
                        if not chunk.text:
                            continue
                        await emit_and_track(parser.feed(chunk.text))
                except LlmError as exc:
                    # 第一轮文本/工具结果已产出：收尾后由下方统一推 error 事件
                    llm_error = exc
                    logger.warning(
                        "搜索结果续写失败（{}）：{}", exc.code, exc.message
                    )

            if not emotion_seen:
                # 容忍模型不输出情绪标签：默认 neutral、不报错
                last_emotion = "neutral"
                await sink.emotion(message_id, "neutral", 1.0)

            # 分句收尾：flush 残余；标记最后一句（其音频帧 final=true）
            if splitter is not None:
                await emit_sentences(splitter.flush())
                if voice_reply is not None and sentence_seq > 0:
                    voice_reply.mark_final(sentence_seq - 1)

            # 等待本轮全部音频帧送出：reply_end 永远晚于音频
            if voice_reply is not None:
                await voice_reply.finish()

            full_text = "".join(clean_parts)
            if full_text:
                await save_message(
                    "assistant",
                    full_text,
                    emotion=last_emotion,
                    saved_client_id=message_id,
                    created_at=reply_created_at,
                )
            await sink.reply_end(message_id, full_text)
            # 派发工具调用（§4.7）：协议约定在 reply_end 之后推送
            for tool_id, tool_name, tool_args in frontend_calls:
                await sink.tool_call(tool_id, tool_name, tool_args)
            # backend 型工具已执行完毕：把确定性结果推成 notice（不进历史/TTS）
            for tool_name, result in backend_results:
                await send_notice(
                    sink,
                    str(result.get("code") or f"{tool_name}_result"),
                    str(result.get("message") or "已经办好啦～"),
                    "info" if result.get("ok") else "warn",
                )
            if forced_tool_missed and llm_error is None:
                missed_code, missed_text = forced_tool_missed_notice(forced_tool)
                await send_notice(sink, missed_code, missed_text, "warn")
            if llm_error is not None:
                # 回复先定型，再报错说明原因（前端不会卡在 thinking）
                await sink.error(str(llm_error.code), llm_error.message)
            await sink.state("idle")
        except asyncio.CancelledError:
            # 打断（§7.2）：先取消 TTS（丢弃未合成队列、停止推帧），再收尾回复
            if voice_reply is not None:
                await voice_reply.cancel()
            if reply_started:
                # 以已产出的文本收尾，前端据此停止播放并回 idle
                partial = "".join(clean_parts)
                if partial:
                    # 用户已看到的半截回复（含其最后情绪），照实落库
                    await save_message(
                        "assistant",
                        partial,
                        emotion=last_emotion,
                        saved_client_id=message_id,
                        created_at=reply_created_at,
                    )
                try:
                    await sink.reply_end(message_id, partial, interrupted=True)
                    await sink.state("idle")
                except Exception:  # 连接可能已断开，收尾失败不影响取消语义
                    logger.debug("中断收尾事件发送失败（连接可能已断开）")
            raise
        finally:
            logger.debug("对话结束 session={} message_id={}", session.id, message_id)

    # ---------- 兼容入口（单测直接调用；实现已下沉到 prompts/tools） ----------

    async def _build_messages(
        self, session: Session, *, user_text: str
    ) -> list[ChatMessage]:
        """组装本轮 messages（见 PromptBuilder.build_messages）。"""
        return await self._prompts.build_messages(session, user_text=user_text)

    async def _execute_tool_calls(
        self, calls: list[tuple[str, str, dict[str, Any]]], user_text: str
    ) -> tuple[
        list[tuple[str, str, dict[str, Any]]], list[tuple[str, dict[str, Any]]]
    ]:
        """按 executor 分流（见 chat_pipeline.tools.execute_tool_calls）。"""
        return await execute_tool_calls(self._tools, calls, user_text)
