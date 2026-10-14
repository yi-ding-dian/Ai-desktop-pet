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
- 对话历史：内存态最近 N 轮，由 application.session.Session 维护
  （SQLite 落库为后续步骤）；
- ``state:thinking`` 在发起 LLM 请求**之前**推送——推理型模型（如 deepseek-flash）
  的思考耗时是真实存在的，前端需要立刻进入"思考中"态；
- LLM 失败（LlmError）：以已产出文本收尾 reply_end，再推 error 事件提示原因，
  最后回到 idle——保证前端不会卡在 thinking；
- TTS 失败（任务书第 5 条）：单句失败跳过该句（对话不受影响）；连续失败达阈值
  由语音层停用本次连接的 TTS 并推一次 error{TTS_FAILED}（非 fatal）。
"""

from __future__ import annotations

import asyncio
import uuid
from typing import TYPE_CHECKING, Awaitable, Callable, Protocol

from loguru import logger

from backend.application.session import Session
from backend.modules.chat.emotion import (
    EMOTION_VALUES,
    EmotionPart,
    EmotionTagParser,
    Part,
    TextPart,
)
from backend.modules.llm.prompts import build_system_prompt
from backend.modules.llm.provider import ChatMessage, LLMProvider
from backend.modules.voice.splitter import SentenceSplitter
from backend.shared.errors import LlmError

if TYPE_CHECKING:  # 仅类型注解；运行时经 Protocol/鸭子类型协作（避免循环 import）
    from backend.application.voice import ReplyVoice, VoiceOut


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

    async def error(self, code: str, message: str) -> None: ...

    async def send_binary(self, frame: bytes) -> None: ...


#: 句子是否"可发音"（含字母/数字/汉字才值得合成）——纯标点、空白、emoji 跳过
def _is_speakable(text: str) -> bool:
    return any(ch.isalnum() for ch in text)


class ChatPipeline:
    """一轮对话的编排器。"""

    def __init__(self, provider: LLMProvider) -> None:
        self._provider = provider

    async def run_turn(
        self,
        sink: ReplySink,
        *,
        session: Session,
        user_text: str,
        voice: VoiceOut | None = None,
    ) -> None:
        """执行一轮对话；被取消（interrupt / 新消息抢占）时按 §7.2 收尾。

        该协程由 interfaces 层以后台任务方式运行，运行期间消息循环保持可用。
        ``voice``：连接级语音出站（application.voice.VoiceOut）；None 表示未启用
        语音——不推 sentence、不合成音频，行为与 Phase 1 完全一致。
        """
        message_id = f"m_{uuid.uuid4().hex}"
        parser = EmotionTagParser()
        clean_parts: list[str] = []
        emotion_seen = False
        reply_started = False
        llm_error: LlmError | None = None

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

        try:
            await sink.state("thinking")  # 必须在发起请求前（见模块 docstring）
            session.append_message("user", user_text)
            await sink.reply_start(message_id)
            reply_started = True

            try:
                async for chunk in self._provider.stream_chat(self._build_messages(session)):
                    if chunk.text:
                        emotion_seen |= await self._emit(
                            sink,
                            message_id,
                            parser.feed(chunk.text),
                            clean_parts,
                            on_clean_text=on_clean_text,
                        )
            except LlmError as exc:
                # 失败已业务化、已脱敏；先把缓冲收尾，再统一走失败收尾（下方）
                llm_error = exc
                logger.warning("LLM 请求失败（{}）：{}", exc.code, exc.message)

            # 流结束（含失败）：残留半标签按普通文本吐出（§4.2）
            emotion_seen |= await self._emit(
                sink, message_id, parser.flush(), clean_parts, on_clean_text=on_clean_text
            )
            if not emotion_seen:
                # 容忍模型不输出情绪标签：默认 neutral、不报错（补发一次显式事件）
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
                session.append_message("assistant", full_text)
            await sink.reply_end(message_id, full_text)
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
                    session.append_message("assistant", partial)  # 用户已看到的半截回复
                try:
                    await sink.reply_end(message_id, partial, interrupted=True)
                    await sink.state("idle")
                except Exception:  # 连接可能已断开，收尾失败不影响取消语义
                    logger.debug("中断收尾事件发送失败（连接可能已断开）")
            raise
        finally:
            logger.debug("对话结束 session={} message_id={}", session.id, message_id)

    # ---------- 内部实现 ----------

    @staticmethod
    def _build_messages(session: Session) -> list[ChatMessage]:
        """组装本轮请求 messages（§4.1/§4.2）：

            system(人格 + 情绪指令) → 最近 N 轮原文（含本轮用户输入）

        画像 / 记忆召回的第二段 system 由后续 memory 步骤注入。
        """
        return [
            ChatMessage(role="system", content=build_system_prompt()),
            *session.recent_messages(),
        ]

    @staticmethod
    async def _emit(
        sink: ReplySink,
        message_id: str,
        parts: list[Part],
        clean_parts: list[str],
        *,
        on_clean_text: Callable[[str], Awaitable[None]] | None = None,
    ) -> bool:
        """按顺序推送解析结果（顺序保真）：文本 → token，情绪 → emotion。

        ``on_clean_text``：干净文本的旁路回调（语音链路喂分句器用），
        不改变 token 事件的推送顺序与内容。

        返回本批是否推送过 emotion 事件（供"默认 neutral"判定）。
        """
        saw_emotion = False
        for part in parts:
            if isinstance(part, TextPart):
                clean_parts.append(part.text)
                await sink.token(message_id, part.text)
                if on_clean_text is not None:
                    await on_clean_text(part.text)
            elif isinstance(part, EmotionPart):
                if part.emotion in EMOTION_VALUES:
                    saw_emotion = True
                    await sink.emotion(message_id, part.emotion, 1.0)
                else:
                    # 白名单外的标签已剥离，不向前端推送未知情绪
                    logger.warning("忽略 v1 情绪集合外的标签：<emo:{}>", part.emotion)
        return saw_emotion
