"""语音出站编排（application 层，设计文档 §4.4 / §7.2）。

两层结构：
- ``VoiceOut``：**连接级**（跨轮存活）——持有 TTSProvider 与"连续失败"降级
  状态；连续失败达阈值后本次连接内停用 TTS（任务书第 5 条），对话不受影响；
- ``ReplyVoice``：**一轮回复级**——句子入队后由后台 worker 串行合成，
  按序推送二进制音频帧（一句话一帧，§3.5）。

并发模型：
- 每个 ReplyVoice 惰性启动一个 asyncio.Task 消费队列（同一回复内串行保序）；
- 流结束 ``finish()``：等待队列排空后才返回——流水线随后才推 reply_end /
  state:idle，保证"该回复的全部音频帧先于 reply_end"，前端收口无歧义；
- 打断 ``cancel()``：清空未合成队列 + 取消合成中的任务（已合成的帧不再推，§7.2）。

依赖说明：本模块（application）直接使用协议层的 ``pack_audio_frame``/
``make_audio_header``——音频帧字节格式由协议层（interfaces/ws/protocol）唯一
定义（§3.5），此处只负责构造语义字段，不感知 WS 传输。
"""

from __future__ import annotations

import asyncio
import contextlib
from typing import Protocol

from loguru import logger

from backend.interfaces.ws.protocol import make_audio_header, pack_audio_frame
from backend.modules.voice.tts.provider import TTSProvider
from backend.shared.errors import ErrorCode, TtsError, TtsErrorCode


class VoiceSink(Protocol):
    """ReplyVoice 需要的出站端口（ReplySink 的结构子集，接口隔离）。"""

    async def error(self, code: str, message: str) -> None: ...

    async def send_binary(self, frame: bytes) -> None: ...


#: 单句合成超时（秒）：网络挂起时兜底，超时按单句失败处理（不阻塞 reply_end）
SYNTH_TIMEOUT = 10.0
#: 连续失败阈值：达到即本次连接内停用 TTS（任务书第 5 条）
FAIL_THRESHOLD = 3
#: 日志中文本摘要的最大长度（脱敏：不落完整模型输出）
_LOG_EXCERPT = 16


class VoiceOut:
    """连接级语音出站：TTS provider + 连续失败降级状态。"""

    def __init__(
        self,
        provider: TTSProvider,
        *,
        synth_timeout: float = SYNTH_TIMEOUT,
        fail_threshold: int = FAIL_THRESHOLD,
    ) -> None:
        self._provider = provider
        self._synth_timeout = synth_timeout
        self._fail_threshold = fail_threshold
        self._fail_streak = 0
        self._disabled = False

    @property
    def available(self) -> bool:
        """TTS 是否可用（未被连续失败停用）。"""
        return not self._disabled

    @property
    def disabled(self) -> bool:
        """本次连接内是否已停用 TTS。"""
        return self._disabled

    def open_reply(self, sink: VoiceSink, message_id: str) -> ReplyVoice:
        """开启一轮回复的语音合成器。"""
        return ReplyVoice(self, sink, message_id)

    async def synthesize(self, text: str) -> bytes:
        """带超时的合成；超时翻译为业务化 TtsError。"""
        try:
            return await asyncio.wait_for(
                self._provider.synthesize(text), timeout=self._synth_timeout
            )
        except asyncio.TimeoutError as exc:
            raise TtsError(
                TtsErrorCode.TTS_TIMEOUT, f"TTS 合成超时（>{self._synth_timeout:.0f}s）"
            ) from exc

    # ---------- 失败降级状态（ReplyVoice 回调） ----------

    def report_success(self) -> None:
        """一句合成成功：清零连续失败计数。"""
        self._fail_streak = 0

    def report_failure(self, text: str, exc: BaseException) -> bool:
        """一句合成失败：记日志（脱敏）→ 累计连续失败。

        返回 True 表示"本次失败恰好触达停用阈值"（调用方据此推一次 error 事件）。
        """
        self._fail_streak += 1
        logger.warning(
            "TTS 合成失败（连续第 {} 次，{}）：text={!r}",
            self._fail_streak,
            type(exc).__name__,
            _excerpt(text),
        )
        if self._fail_streak >= self._fail_threshold and not self._disabled:
            self._disabled = True
            logger.error(
                "TTS 连续失败 {} 次，本次连接内停用语音（对话不受影响）", self._fail_streak
            )
            return True
        return False


class ReplyVoice:
    """一轮回复的 TTS 串行合成器：入队句子 → 顺序合成 → 推二进制帧。"""

    def __init__(self, out: VoiceOut, sink: VoiceSink, message_id: str) -> None:
        self._out = out
        self._sink = sink
        self._message_id = message_id
        self._queue: asyncio.Queue[tuple[int, str]] = asyncio.Queue()
        self._worker: asyncio.Task[None] | None = None
        self._final_seq: int = -1
        self._closed = False

    @property
    def enabled(self) -> bool:
        """当前是否仍应推送句子（连接被停用后流水线停止再推 sentence/入队）。"""
        return self._out.available

    def push(self, seq: int, text: str) -> None:
        """入队一句待合成文本（幂等保护：finish/cancel 后忽略）。"""
        if self._closed or not self.enabled:
            return
        self._queue.put_nowait((seq, text))
        if self._worker is None or self._worker.done():
            self._worker = asyncio.create_task(self._run(), name=f"tts-{self._message_id}")

    def mark_final(self, seq: int) -> None:
        """标记最后一句的 seq：其音频帧头 final=true。

        须在该句开始合成前调用（流水线在流结束 flush 后立即调用，通常成立）；
        若该句已合成/已发送则标记失效——此时前端以 reply_end 作为音频流封口兜底。
        """
        self._final_seq = seq

    async def finish(self) -> None:
        """流结束：等待队列排空（单句失败按跳过处理），随后停止 worker。"""
        self._closed = True
        worker = self._worker
        if worker is None:
            return
        # worker 兜底了所有业务异常，join 不会悬挂；仅 cancel 链（打断）会打断它
        await self._queue.join()
        self._worker = None
        await self._stop(worker)

    async def cancel(self) -> None:
        """打断（§7.2）：清空未合成队列 + 取消合成中的任务（已合成的帧不再推）。幂等。"""
        self._closed = True
        while True:
            try:
                self._queue.get_nowait()
            except asyncio.QueueEmpty:
                break
            else:
                self._queue.task_done()
        worker = self._worker
        self._worker = None
        if worker is not None and not worker.done():
            worker.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await worker

    # ---------- 内部实现 ----------

    async def _run(self) -> None:
        """串行消费队列；任何单句异常都不允许逃逸（finish 的 join 依赖于此）。"""
        while True:
            seq, text = await self._queue.get()
            try:
                await self._synthesize_and_send(seq, text)
            except asyncio.CancelledError:
                raise  # 打断：放弃剩余处理，交由 cancel() 收口
            except Exception:  # 兜底：编排层自身缺陷也不得悬挂 finish
                logger.exception("TTS 任务内部异常（已跳过该句）")
            finally:
                self._queue.task_done()

    async def _synthesize_and_send(self, seq: int, text: str) -> None:
        if not self._out.available:
            return  # 本次连接已停用 TTS：跳过剩余句子（帧不再推）
        final = seq == self._final_seq  # 在合成前取值（mark_final 须先于合成生效）
        try:
            audio = await self._out.synthesize(text)
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # TtsError / 意外异常 —— 统一按单句失败降级
            just_disabled = self._out.report_failure(text, exc)
            if just_disabled:
                # 达到阈值：推一次非 fatal error（任务书第 5 条），对话继续
                await self._sink.error(
                    ErrorCode.TTS_FAILED,
                    "语音合成连续失败，本次会话已暂停语音播报（对话不受影响）",
                )
            return
        self._out.report_success()
        frame = pack_audio_frame(
            make_audio_header(self._message_id, seq, final=final), audio
        )
        await self._sink.send_binary(frame)

    async def _stop(self, worker: asyncio.Task[None]) -> None:
        """停止 worker（此刻阻塞在队列 get 上）：cancel 并吞掉取消。"""
        if worker.done():
            return
        worker.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await worker


def _excerpt(text: str, limit: int = _LOG_EXCERPT) -> str:
    """日志用文本摘要（脱敏：不落完整模型输出）。"""
    return text if len(text) <= limit else text[:limit] + "…"
