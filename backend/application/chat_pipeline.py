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
from backend.modules.memory.format import build_memory_block
from backend.modules.voice.splitter import SentenceSplitter
from backend.shared.errors import LlmError

if TYPE_CHECKING:  # 仅类型注解；运行时经 Protocol/鸭子类型协作（避免循环 import）
    from backend.application.voice import ReplyVoice, VoiceOut
    from backend.modules.memory.profile import ProfileStore
    from backend.modules.memory.store import MemoryStore


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
    """一轮对话的编排器。

    ``memories`` / ``profile``（可选注入，P3 记忆）：缺省 None 时行为与
    P1/P2 完全一致；装配后每轮组装第二条 system（画像 + 召回记忆）。

    ``pet_name``（可选注入，§7.6.3）：读当前 ``pet.name`` 配置的回调——每轮
    组装 system prompt 时动态取名字注入（"你的名字叫 X"）；缺省 None 不注入，
    行为与旧版一致。
    """

    def __init__(
        self,
        provider: LLMProvider,
        *,
        memories: MemoryStore | None = None,
        profile: ProfileStore | None = None,
        pet_name: Callable[[], str | None] | None = None,
    ) -> None:
        self._provider = provider
        self._memories = memories
        self._profile = profile
        self._pet_name = pet_name

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
        last_emotion: str | None = None  # 本轮最后出现的情绪（随 assistant 消息落库）
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
                async for chunk in self._provider.stream_chat(
                    await self._build_messages(session, user_text=user_text)
                ):
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
            except LlmError as exc:
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
