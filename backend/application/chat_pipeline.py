"""对话流水线（真 LLM 版 + 语音链路）。

一轮对话的用户可见事件流，严格按设计文档 §7.1 时序编排：

    user_message
      → state:thinking → reply_start → token / emotion（流式）
          └─ 干净文本同时喂 splitter → 完整句：sentence 事件 + TTS 任务
                                        → 合成完推二进制音频帧（§3.5）
      →（等待本轮语音帧全部送出）→ reply_end → state:idle

- 与 WS 协议解耦：通过出站端口 ReplySink 输出，由 interfaces/ws 实现为协议事件；
- 情绪标签解析交给 modules/chat/emotion（跨片段切分安全）；
- 分句交给 modules/voice/splitter（跨片段边界安全）；
- TTS 编排交给 application/voice（连接级 VoiceOut + 轮级 ReplyVoice）：
  句子在流水线内入队，合成/推帧在后台任务中串行进行；
- LLM 由注入的 LLMProvider 提供（生产：OpenAICompatProvider；测试：tests/fakes.py）；
- 对话历史：由 application.session.Session 维护最近 N 轮，并增量落库
  （P3：SQLite messages 表，进程重启后 load_history 可回填）；
- 记忆注入（P3）：``_build_messages`` 在 system(人格) 之后追加一段
  system(画像 + 召回记忆)——有内容才注入；召回失败只降级、不阻断对话；
- ``state:thinking`` 在发起 LLM 请求**之前**推送——推理型模型（如 deepseek-flash）
  的思考耗时是真实存在的，前端需要立刻进入"思考中"态；
- LLM 失败（LlmError）：以已产出文本收尾 reply_end，再推 error 事件提示原因，
  最后回到 idle——保证前端不会卡在 thinking；
- TTS 失败（任务书第 5 条）：单句失败跳过该句（对话不受影响）；连续失败达阈值
  由语音层停用本次连接的 TTS 并推一次 error{TTS_FAILED}（非 fatal）。
- 工具机制（§4.7）：注入 ``tools`` 注册表后启用——三层保底：
  1) 快通道：用户输入命中内置指令词表（match_directive）→ **不调 LLM**，
     本地 ack 走正常事件流（thinking → reply_start → token → happy →
     reply_end → tool_call → idle），用户消息与 ack 照常落库——"打开设置"
     这类高频指令必须必达，不能被模型的不确定性拖累；
  2) 模型路径：请求携带 tools → 流式累积 ``Chunk.tool_delta``（按 index 归组
     拼接 arguments）→ ``reply_end`` 之后派发 ``sink.tool_call``；模型只调工具、
     没产出正文时（真机实测会发生），用该工具 spec 的 ack 补一句（走 token/分句
     路径，TTS 可播报），避免用户端静默；
  3) 降级：带 tools 的请求被 LLM_BAD_REQUEST 拒绝且本轮无任何产出（疑似网关/
     模型不支持 tools）→ 摘除 tools 重放一次；再败以第一次错误收尾。降级置
     **进程级标记**（模块变量）——后续轮不再携带 tools（快通道不受影响）。
"""

from __future__ import annotations

import asyncio
import json
import uuid
from typing import TYPE_CHECKING, Any, Awaitable, Callable, Protocol, Sequence

from loguru import logger

from backend.application.session import Session
from backend.modules.chat.emotion import (
    EMOTION_VALUES,
    EmotionPart,
    EmotionTagParser,
    Part,
    TextPart,
)
from backend.modules.files import (
    FileLimits,
    FileRejected,
    FileRef,
    build_attachment_block,
    build_attachment_user_content,
    estimate_messages_tokens,
    read_attachments,
)
from backend.modules.llm.prompts import build_system_prompt
from backend.modules.llm.provider import ChatMessage, LLMProvider
from backend.modules.memory.format import build_memory_block
from backend.modules.tools import ToolRegistry, ToolSpec, match_directive
from backend.modules.voice.splitter import SentenceSplitter
from backend.shared.errors import LlmError, LlmErrorCode

if TYPE_CHECKING:  # 仅类型注解；运行时经 Protocol/鸭子类型协作（避免循环 import）
    from backend.application.voice import ReplyVoice, VoiceOut
    from backend.modules.memory.profile import ProfileStore
    from backend.modules.memory.store import MemoryStore
    from backend.shared.config import AppConfig


class ReplySink(Protocol):
    """对话流水线的出站端口（依赖倒置：由 interfaces 层实现为 WS 事件）。"""

    async def state(self, state: str) -> None: ...

    async def reply_start(self, message_id: str) -> None: ...

    async def token(self, message_id: str, text: str) -> None: ...

    async def sentence(self, message_id: str, index: int, text: str) -> None: ...

    async def emotion(self, message_id: str, emotion: str, intensity: float) -> None: ...

    async def reply_end(
        self, message_id: str, full_text: str, *, interrupted: bool = False
    ) -> None: ...

    async def tool_call(self, tool_id: str, name: str, args: dict) -> None:
        """本轮模型请求的工具调用（§4.7）：前端执行（如 open_settings → 开设置窗）。

        reply_end 之后推送；首版前端不回收执（"结果回传续写"属知识库阶段扩展）。
        """
        ...

    async def error(self, code: str, message: str) -> None: ...

    async def send_binary(self, frame: bytes) -> None: ...

    async def notice(self, code: str, message: str, level: str = "info") -> None:
        """一次性提示（文件分析丢弃旧上下文等）；不进入回复正文/历史/TTS。"""
        ...


#: 句子是否"可发音"（含字母/数字/汉字才值得合成）——纯标点、空白、emoji 跳过
def _is_speakable(text: str) -> bool:
    return any(ch.isalnum() for ch in text)


def _stored_user_text(user_text: str, refs: Sequence[FileRef]) -> str:
    """历史/落库用的脱敏用户消息：``📎 文件名`` + 问题，不含文件正文与绝对路径。"""
    names = "、".join(ref.display_name for ref in refs)
    label = f"📎 {names}"
    text = user_text.strip()
    return f"{label}\n{text}" if text else label


#: 工具 ack 为空时的通用兜底文案（§4.7）——快通道工具未配 ack、或模型只调工具
#: 没产出正文且该工具 spec 无 ack 时，用它补一句口语回应，避免用户端静默。
_FALLBACK_ACK = "好嘞，已经帮你办好啦～"

#: 进程级降级标记（§4.7）：带 tools 的请求被 LLM_BAD_REQUEST 拒绝且本轮无产出
#: （疑似网关/模型不支持 tools）→ 置位后本进程后续轮不再携带 tools。
#: 为什么用模块变量：降级结论对"这个网关 + 模型"是进程级事实，跨连接/跨会话共享；
#: 快通道（内置指令词表）不依赖模型 tools 能力，不受该标记影响、照常可用。
_tools_unsupported = False


def _mark_tools_unsupported() -> None:
    """置位进程级降级标记（首次置位原因由调用点 logger.warning 说明）。"""
    global _tools_unsupported
    _tools_unsupported = True


def _reset_tools_support_state() -> None:
    """重置进程级降级标记——仅供测试做用例间隔离（生产代码不调用）。"""
    global _tools_unsupported
    _tools_unsupported = False


class ChatPipeline:
    """一轮对话的编排器。

    ``memories`` / ``profile``（可选注入，P3 记忆）：缺省 None 时行为与
    P1/P2 完全一致；装配后每轮组装第二条 system（画像 + 召回记忆）。

    ``pet_name``（可选注入，§7.6.3）：读当前 ``pet.name`` 配置的回调——每轮
    组装 system prompt 时动态取名字注入（"你的名字叫 X"）；缺省 None 不注入，
    行为与旧版一致。

    ``tools``（可选注入，§4.7 工具机制）：内置工具注册表；缺省 None 时
    行为与旧版完全一致（不做指令快通道、请求不携带 tools）。
    """

    def __init__(
        self,
        provider: LLMProvider,
        *,
        memories: MemoryStore | None = None,
        profile: ProfileStore | None = None,
        pet_name: Callable[[], str | None] | None = None,
        tools: ToolRegistry | None = None,
        config: Callable[[], AppConfig] | None = None,
    ) -> None:
        self._provider = provider
        self._memories = memories
        self._profile = profile
        self._pet_name = pet_name
        self._tools = tools
        # 配置活引用（文件限额 / 上下文预算每轮动态读，设置保存后下一轮即生效）；
        # None = 测试/未装配场景，使用保守默认值。
        self._config = config

    async def run_turn(
        self,
        sink: ReplySink,
        *,
        session: Session,
        user_text: str,
        voice: VoiceOut | None = None,
        attachments: Sequence[FileRef] | None = None,
    ) -> None:
        """执行一轮对话；被取消（interrupt / 新消息抢占）时按 §7.2 收尾。

        该协程由 interfaces 层以后台任务方式运行，运行期间消息循环保持可用。
        ``voice``：连接级语音出站（application.voice.VoiceOut）；None 表示未启用
        语音——不推 sentence、不合成音频，行为与 Phase 1 完全一致。

        工具机制（§4.7，仅装配 ``tools`` 时）：命中内置指令词表走快通道（不调
        LLM，本地 ack 走正常事件流）；否则正常 LLM 流（携带 tools，除非进程级
        降级标记已置位），流末解析工具分片、``reply_end`` 之后派发 ``tool_call``。

        文件分析（P1，``attachments`` 非空时）：先本地读取并校验字数/大小，
        超限直接本地拒绝（不调 LLM）；上下文超预算先丢历史（notice 提示），
        仍超则拒绝。文件正文只注入本轮，历史里只存"📎 文件名 + 问题"。
        """
        message_id = f"m_{uuid.uuid4().hex}"
        parser = EmotionTagParser()
        clean_parts: list[str] = []
        emotion_seen = False
        last_emotion: str | None = None  # 本轮最后出现的情绪（随 assistant 消息落库）
        reply_started = False
        llm_error: LlmError | None = None
        # 工具机制（§4.7）：本轮待派发的调用 [(tool_id, name, args)]——快通道预置、
        # 模型路径在流末解析；tool_acc 为模型分片按 index 的归组累积。
        tool_calls_to_emit: list[tuple[str, str, dict[str, Any]]] = []
        tool_acc: dict[int, dict[str, Any]] = {}

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
                    return  # 运行中 TTS 被停用：不再推 sentence（前端不必等待音频）
                if not _is_speakable(text):
                    continue  # 纯标点 / 空白 / emoji：无可发音内容，跳过
                await sink.sentence(message_id, sentence_seq, text)
                voice_reply.push(sentence_seq, text)
                sentence_seq += 1

        async def on_clean_text(text: str) -> None:
            """LLM 输出的干净文本（已剥离情绪标签）→ 喂给分句器。"""
            if splitter is not None:
                await emit_sentences(splitter.feed(text))

        # ---- 文件分析（P1）：附件在调 LLM 前读取/限额；正文只注入本轮、不落库 ----
        file_refs = list(attachments or [])
        # 历史里只存文件名（不含正文）：下一轮不会重复把整个文件送给模型
        stored_user_text = (
            _stored_user_text(user_text, file_refs) if file_refs else user_text
        )
        llm_messages: list[ChatMessage] | None = None

        async def reject_with(text: str) -> None:
            """本地拒绝（不调 LLM）：用户消息照常落库，回复走气泡事件流。"""
            nonlocal reply_started, emotion_seen, last_emotion
            session.append_message("user", stored_user_text)
            await sink.reply_start(message_id)
            reply_started = True
            clean_parts.append(text)
            await sink.token(message_id, text)
            emotion_seen = True
            last_emotion = "sad"
            await sink.emotion(message_id, "sad", 1.0)
            session.append_message("assistant", text, emotion="sad")
            await sink.reply_end(message_id, text)
            await sink.state("idle")

        # 快通道判定（§4.7，仅装配注册表时）："打开设置"这类高频指令命中词表 →
        # 不调 LLM（模型的不确定性 / 网关不支持 tools 都不拖累必达语义）。
        # 带附件时不走快通道：用户显然是要分析文件，不能被词表命中截胡。
        directive_spec: ToolSpec | None = None
        if self._tools is not None and not file_refs:
            directive_spec = self._match_directive(user_text)

        try:
            await sink.state("thinking")  # 必须在发起请求前（见模块 docstring）

            if file_refs:
                limits = self._file_limits()
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
                memory_block = await self._build_memory_block(user_text)
                history = session.recent_messages()  # 当前用户消息尚未 append
                candidate = self._compose_messages(
                    memory_block, history, content, images=images
                )
                budget = self._context_budget()
                if estimate_messages_tokens(candidate) > budget:
                    without_history = self._compose_messages(
                        memory_block, [], content, images=images
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
                        await self._send_notice(
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

            session.append_message("user", stored_user_text)
            await sink.reply_start(message_id)
            reply_started = True

            if directive_spec is not None:
                # 快通道：本地 ack 走正常事件流（token / 分句 / 落库与模型路径一致）。
                # happy 情绪显式推送并预置 emotion_seen，避免流末又补 neutral 覆盖。
                ack_text = directive_spec.ack or _FALLBACK_ACK
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
                    else await self._build_messages(session, user_text=user_text)
                )
                use_tools = self._tools is not None and not _tools_unsupported
                request_opts: dict[str, Any] = {}
                if use_tools:
                    request_opts["tools"] = self._tools.to_openai_tools()

                async def consume_stream(**opts: Any) -> None:
                    """消费一次 LLM 流（首次请求与降级重放共用同一实现，防两处走样）。"""
                    nonlocal emotion_seen, last_emotion
                    async for chunk in self._provider.stream_chat(messages, **opts):
                        if chunk.text:
                            emotion = await self._emit(
                                sink,
                                message_id,
                                parser.feed(chunk.text),
                                clean_parts,
                                on_clean_text=on_clean_text,
                            )
                            if emotion is not None:
                                emotion_seen = True
                                last_emotion = emotion
                        delta = chunk.tool_delta
                        if delta is not None:
                            # 按 index 归组：id/name 通常只在首片，arguments 逐片拼接
                            acc = tool_acc.setdefault(
                                delta.index, {"id": None, "name": None, "arguments": ""}
                            )
                            if delta.id:
                                acc["id"] = delta.id
                            if delta.name:
                                acc["name"] = delta.name
                            if delta.arguments:
                                acc["arguments"] += delta.arguments

                try:
                    await consume_stream(**request_opts)
                except LlmError as exc:
                    if (
                        use_tools
                        and exc.code == LlmErrorCode.LLM_BAD_REQUEST
                        and not clean_parts
                        and not tool_acc
                    ):
                        # 降级（§4.7）：疑似网关/模型不支持 tools——摘除后重放本轮；
                        # 置进程级标记，后续轮直接不带 tools（快通道不受影响）。
                        logger.warning(
                            "工具请求被拒（{}），疑似网关/模型不支持 tools；"
                            "摘除 tools 重放本轮：{}",
                            exc.code,
                            exc.message,
                        )
                        _mark_tools_unsupported()
                        try:
                            await consume_stream()  # 重放：不带 tools
                        except LlmError as retry_exc:
                            # 重放再败：以第一次错误收尾（对用户更有指向性）
                            logger.warning(
                                "摘除 tools 重放仍失败（{}）：{}",
                                retry_exc.code,
                                retry_exc.message,
                            )
                            llm_error = exc
                    else:
                        # 失败已业务化、已脱敏；先把缓冲收尾，再统一走失败收尾（下方）
                        llm_error = exc
                        logger.warning("LLM 请求失败（{}）：{}", exc.code, exc.message)

            # 流结束（含失败）：残留半标签按普通文本吐出（§4.2）
            flushed_emotion = await self._emit(
                sink, message_id, parser.flush(), clean_parts, on_clean_text=on_clean_text
            )
            if flushed_emotion is not None:
                emotion_seen = True
                last_emotion = flushed_emotion

            # 工具调用收口（§4.7）：解析模型分片（快通道已预置，此处为空操作）。
            # 模型只调工具、没产出正文（真机实测会发生）→ 用工具 ack 补一句，
            # 走 token / 分句路径（前端可见、TTS 可播报），避免用户端静默。
            tool_calls_to_emit.extend(self._collect_tool_calls(tool_acc))
            if tool_calls_to_emit and not clean_parts:
                ack_text = self._ack_for(tool_calls_to_emit[0][1])
                clean_parts.append(ack_text)
                await sink.token(message_id, ack_text)
                await on_clean_text(ack_text)

            if not emotion_seen:
                # 容忍模型不输出情绪标签：默认 neutral、不报错（补发一次显式事件）
                last_emotion = "neutral"
                await sink.emotion(message_id, "neutral", 1.0)

            # 分句收尾：flush 残余；标记最后一句（其音频帧 final=true）
            if splitter is not None:
                await emit_sentences(splitter.flush())
                if voice_reply is not None and sentence_seq > 0:
                    voice_reply.mark_final(sentence_seq - 1)

            # 等待本轮全部音频帧送出：reply_end 永远晚于音频（收口顺序无歧义）
            if voice_reply is not None:
                await voice_reply.finish()

            full_text = "".join(clean_parts)
            if full_text:
                session.append_message("assistant", full_text, emotion=last_emotion)
            await sink.reply_end(message_id, full_text)
            # 派发工具调用（§4.7）：协议约定在对应回复的 reply_end 之后推送，
            # 前端按 name 执行（如 open_settings → 打开设置窗）；工具调用本身
            # 不进对话历史（assistant 只存正文/补话，见上方 append_message）。
            for tool_id, tool_name, tool_args in tool_calls_to_emit:
                await sink.tool_call(tool_id, tool_name, tool_args)
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
                    session.append_message("assistant", partial, emotion=last_emotion)
                try:
                    await sink.reply_end(message_id, partial, interrupted=True)
                    await sink.state("idle")
                except Exception:  # 连接可能已断开，收尾失败不影响取消语义
                    logger.debug("中断收尾事件发送失败（连接可能已断开）")
            raise
        finally:
            logger.debug("对话结束 session={} message_id={}", session.id, message_id)

    # ---------- 内部实现 ----------

    def _match_directive(self, user_text: str) -> ToolSpec | None:
        """用户输入命中内置指令词表且可走快通道时返回对应 ToolSpec，否则 None。

        仅 frontend 型工具可走快通道：backend 型本期无执行调度（遇到记日志、
        降级走正常流）；注册表缺该工具（装配不一致）同样降级——宁可多问一次
        模型，也不能"命中却无事发生"。
        """
        assert self._tools is not None  # 调用方保证（仅装配注册表时调用）
        name = match_directive(user_text)
        if name is None:
            return None
        spec = self._tools.get(name)
        if spec is None:
            logger.warning("指令命中工具 {} 但注册表缺该定义（装配不一致），走正常流", name)
            return None
        if spec.executor != "frontend":
            logger.warning("指令命中 backend 型工具 {}（本期未支持执行调度），走正常流", name)
            return None
        return spec

    def _ack_for(self, tool_name: str) -> str:
        """取工具的确认话术（spec.ack）；未注册 / 未配 ack 用通用兜底文案。"""
        spec = self._tools.get(tool_name) if self._tools is not None else None
        if spec is not None and spec.ack:
            return spec.ack
        return _FALLBACK_ACK

    @staticmethod
    def _collect_tool_calls(
        tool_acc: dict[int, dict[str, Any]],
    ) -> list[tuple[str, str, dict[str, Any]]]:
        """把按 index 归组的工具分片解析为 [(tool_id, name, args)]（按 index 序）。

        - arguments：空串按 ``{}``；坏 JSON / 非对象记 warning 按 ``{}``
          （单次参数解析失败不应吞掉整个调用）；
        - name 缺失的分片（理论上不该出现）记 warning 跳过——没有工具名无法执行；
        - id 缺失（少见，通常只在首片）自造，保持协议字段非空。
        """
        calls: list[tuple[str, str, dict[str, Any]]] = []
        for index in sorted(tool_acc):
            item = tool_acc[index]
            name = item["name"]
            if not name:
                logger.warning("工具调用分片缺 name（index={}），跳过派发", index)
                continue
            raw_args = (item["arguments"] or "").strip()
            args: dict[str, Any] = {}
            if raw_args:
                try:
                    parsed = json.loads(raw_args)
                except json.JSONDecodeError:
                    logger.warning("工具调用参数不是合法 JSON（name={}），按空参数派发", name)
                else:
                    if isinstance(parsed, dict):
                        args = parsed
                    else:
                        logger.warning("工具调用参数不是 JSON 对象（name={}），按空参数派发", name)
            calls.append((item["id"] or f"t_{uuid.uuid4().hex[:8]}", name, args))
        return calls

    async def _build_messages(self, session: Session, *, user_text: str) -> list[ChatMessage]:
        """组装本轮请求 messages（§4.1/§4.2）：

            system(人格 + [名字注入] + 情绪指令)
              → system(画像 + 记忆召回)   ← P3：有内容才注入
              → 最近 N 轮原文（含本轮用户输入）

        名字每轮从 ``pet_name`` 回调动态读取（§7.6.3：设置面板改名保存后，
        下一轮对话即注入新名）。召回以本轮用户输入为 query；记忆未装配（None）
        或为空时退化为 P1/P2 的单 system 结构，行为完全一致。
        """
        pet_name = self._pet_name() if self._pet_name is not None else None
        messages = [
            ChatMessage(role="system", content=build_system_prompt(pet_name=pet_name))
        ]
        memory_block = await self._build_memory_block(user_text)
        if memory_block is not None:
            messages.append(ChatMessage(role="system", content=memory_block))
        messages.extend(session.recent_messages())
        return messages

    async def _build_memory_block(self, query: str) -> str | None:
        """画像 + 记忆召回 → 第二条 system 文本；无内容/未装配返回 None。

        - 召回/读画像失败：记日志并降级（本轮不注入），绝不影响对话主链路；
        - 注入后打日志：只记条数（不含记忆全文，INFO 级不落隐私）；
        - 召回命中的记忆顺手更新 last_used_at（供将来"遗忘/降权"策略使用）。
        """
        if self._memories is None and self._profile is None:
            return None

        profile_items = []
        if self._profile is not None:
            try:
                profile_items = self._profile.all()
            except Exception:
                logger.exception("画像读取失败（本轮跳过画像注入）")

        memories = []
        if self._memories is not None:
            try:
                memories = await self._memories.recall(query)
            except Exception:
                logger.exception("记忆召回失败（本轮跳过记忆注入）")

        block = build_memory_block(profile_items, memories)
        if block is None:
            logger.debug("记忆注入：无画像与记忆，跳过")
            return None

        logger.info("记忆注入：画像 {} 条 / 长期记忆 {} 条", len(profile_items), len(memories))
        if memories and self._memories is not None:
            try:
                self._memories.mark_used([memory.id for memory in memories])
            except Exception:
                logger.exception("记忆 last_used_at 更新失败（不影响本轮对话）")
        return block

    # ---------- 文件分析（P1）内部实现 ----------

    def _compose_messages(
        self,
        memory_block: str | None,
        history: Sequence[ChatMessage],
        current_content: str,
        *,
        images: Sequence[str] = (),
    ) -> list[ChatMessage]:
        """文件轮的消息组装：system(人格) + [system(记忆)] + 历史 + 本轮（文本 + 图片）。

        与 ``_build_messages`` 的区别：当前用户消息由调用方给出富内容（文本块 +
        问题 + 图片 data URL），而不是从 session 里取（session 只存了脱敏的
        "📎 文件名 + 问题"）。图片只挂在当前 user 消息上，历史不带图片。
        """
        pet_name = self._pet_name() if self._pet_name is not None else None
        messages = [
            ChatMessage(role="system", content=build_system_prompt(pet_name=pet_name))
        ]
        if memory_block is not None:
            messages.append(ChatMessage(role="system", content=memory_block))
        messages.extend(history)
        messages.append(
            ChatMessage(role="user", content=current_content, images=tuple(images))
        )
        return messages

    def _file_limits(self) -> FileLimits:
        """当前文件限额（热配置；未装配配置的测试场景用 FileLimits 默认值）。"""
        config = self._config() if self._config is not None else None
        if config is None:
            return FileLimits()
        return FileLimits(
            max_chars=config.files.max_chars,
            max_bytes=config.files.max_bytes,
            max_per_turn=config.files.max_per_turn,
            max_image_bytes=config.files.max_image_bytes,
            allow_images=config.files.allow_images,
        )

    def _context_budget(self) -> int:
        """本轮可用**输入** token 预算 = 上下文预算 - 输出预留 - 安全余量。

        输出预留用配置的 ``llm.max_tokens``（推理模型思考也在这部分），再留 512
        给协议/估算误差；下限 1,000，避免配置异常把预算压成负数。
        """
        config = self._config() if self._config is not None else None
        context = config.llm.context_tokens if config is not None else 100_000
        output = config.llm.max_tokens if config is not None else 768
        return max(1_000, context - output - 512)

    @staticmethod
    async def _send_notice(
        sink: ReplySink, code: str, message: str, level: str = "info"
    ) -> None:
        """发一次性提示；旧 sink / 测试替身没有 notice 时静默跳过（不阻断对话）。"""
        notice = getattr(sink, "notice", None)
        if notice is None:
            return
        try:
            await notice(code, message, level)
        except Exception:  # 提示是旁路信息，失败不应影响本轮
            logger.debug("notice 发送失败（忽略）：code={}", code)

    @staticmethod
    async def _emit(
        sink: ReplySink,
        message_id: str,
        parts: list[Part],
        clean_parts: list[str],
        *,
        on_clean_text: Callable[[str], Awaitable[None]] | None = None,
    ) -> str | None:
        """按顺序推送解析结果（顺序保真）：文本 → token，情绪 → emotion。

        ``on_clean_text``：干净文本的旁路回调（语音链路喂分句器用），
        不改变 token 事件的推送顺序与内容。

        返回本批**最后一个**合法情绪名（无情绪时为 None）——供调用方
        跟踪"本轮最后情绪"并随 assistant 消息落库（§6.2 messages.emotion）。
        """
        last_emotion: str | None = None
        for part in parts:
            if isinstance(part, TextPart):
                clean_parts.append(part.text)
                await sink.token(message_id, part.text)
                if on_clean_text is not None:
                    await on_clean_text(part.text)
            elif isinstance(part, EmotionPart):
                if part.emotion in EMOTION_VALUES:
                    last_emotion = part.emotion
                    await sink.emotion(message_id, part.emotion, 1.0)
                else:
                    # 白名单外的标签已剥离，不向前端推送未知情绪
                    logger.warning("忽略 v1 情绪集合外的标签：<emo:{}>", part.emotion)
        return last_emotion
