"""语音链路单测：VoiceOut/ReplyVoice 编排 + chat_pipeline 集成。

覆盖：sentence/audio 事件顺序（reply_end 晚于全部音频帧）、一句话一帧的
帧头字段、final 标记、单句失败跳过、连续失败降级（TTS_FAILED）、
打断时取消 TTS（已合成的帧不再推）、超时翻译、无语音时行为不变。
"""

from __future__ import annotations

import asyncio
from typing import Any

import pytest

from backend.application.chat_pipeline import ChatPipeline
from backend.application.session import SessionManager
from backend.application.voice import VoiceOut
from backend.interfaces.ws.protocol import unpack_audio_frame
from backend.shared.errors import TtsError, TtsErrorCode
from fakes import FAKE_MP3, FakeTTSProvider, ScriptedProvider


class RecordingSink:
    """统一记录文本事件与二进制帧的时序（顺序断言的基础）。"""

    def __init__(self) -> None:
        self.timeline: list[tuple[str, Any]] = []

    async def state(self, state: str) -> None:
        self.timeline.append(("event", ("state", {"state": state})))

    async def reply_start(self, message_id: str) -> None:
        self.timeline.append(("event", ("reply_start", {"message_id": message_id})))

    async def token(self, message_id: str, text: str) -> None:
        self.timeline.append(("event", ("token", {"message_id": message_id, "text": text})))

    async def sentence(self, message_id: str, index: int, text: str) -> None:
        self.timeline.append(
            ("event", ("sentence", {"message_id": message_id, "index": index, "text": text}))
        )

    async def emotion(self, message_id: str, emotion: str, intensity: float) -> None:
        self.timeline.append(
            ("event", ("emotion", {"message_id": message_id, "emotion": emotion}))
        )

    async def reply_end(
        self, message_id: str, full_text: str, *, interrupted: bool = False
    ) -> None:
        self.timeline.append(
            ("event", ("reply_end", {"message_id": message_id, "full_text": full_text,
                                     "interrupted": interrupted}))
        )

    async def error(self, code: str, message: str) -> None:
        self.timeline.append(("event", ("error", {"code": str(code), "message": message})))

    async def send_binary(self, frame: bytes) -> None:
        header, payload = unpack_audio_frame(frame)
        self.timeline.append(("frame", (header, payload)))

    # ---------- 断言辅助 ----------

    def types(self) -> list[str]:
        return [t for kind, (t, _) in self.timeline if kind == "event"]

    def events(self, msg_type: str) -> list[dict[str, Any]]:
        return [d for kind, (t, d) in self.timeline if kind == "event" and t == msg_type]

    def frames(self) -> list[tuple[dict[str, Any], bytes]]:
        return [item for kind, item in self.timeline if kind == "frame"]

    def index_of(self, predicate) -> int:
        for i, (kind, item) in enumerate(self.timeline):
            if predicate(kind, item):
                return i
        raise AssertionError("未找到匹配的时序项")


def run_turn(
    provider: Any, *, voice: VoiceOut | None = None, user_text: str = "你好"
) -> RecordingSink:
    sink = RecordingSink()
    sessions = SessionManager()
    session = sessions.start("s")
    pipeline = ChatPipeline(provider=provider)
    asyncio.run(pipeline.run_turn(sink, session=session, user_text=user_text, voice=voice))
    return sink


# ---------------------------------------------------------------- 正常链路


def test_sentences_and_audio_frames_in_order() -> None:
    tts = FakeTTSProvider()
    provider = ScriptedProvider(["你好呀！我是小豆。今天天气不错。"])
    sink = run_turn(provider, voice=VoiceOut(tts))

    # 分句：三句（末句在流结束时 flush）；seq/index 从 0 递增且一一对应
    sentences = sink.events("sentence")
    assert [(d["index"], d["text"]) for d in sentences] == [
        (0, "你好呀！"),
        (1, "我是小豆。"),
        (2, "今天天气不错。"),
    ]

    frames = sink.frames()
    assert [h["seq"] for h, _ in frames] == [0, 1, 2]
    assert [h["final"] for h, _ in frames] == [False, False, True]
    for header, payload in frames:
        assert header["type"] == "audio"
        assert header["format"] == "mp3"
        assert header["sample_rate"] == 24000
        assert header["message_id"] == sink.events("reply_start")[0]["message_id"]
        assert payload == FAKE_MP3

    # 顺序契约：全部音频帧先于 reply_end；reply_end 先于 state:idle
    last_frame = max(i for i, (kind, _) in enumerate(sink.timeline) if kind == "frame")
    reply_end_at = sink.index_of(lambda kind, item: kind == "event" and item[0] == "reply_end")
    idle_at = sink.index_of(
        lambda kind, item: kind == "event" and item[0] == "state" and item[1]["state"] == "idle"
    )
    assert last_frame < reply_end_at < idle_at
    # sentence 事件先于对应的音频帧（对应句的帧在其 sentence 之后）
    for header, _ in frames:
        seq = header["seq"]
        sent_at = sink.index_of(
            lambda kind, item: kind == "event" and item[0] == "sentence" and item[1]["index"] == seq
        )
        frame_at = sink.index_of(
            lambda kind, item: kind == "frame" and item[0]["seq"] == seq
        )
        assert sent_at < frame_at


def test_chunked_llm_stream_split_across_boundaries() -> None:
    """LLM 片段在句号处切分：分句/合成不受片段边界影响。"""
    tts = FakeTTSProvider()
    provider = ScriptedProvider(["你好", "。今天", "很好。"])
    sink = run_turn(provider, voice=VoiceOut(tts))

    assert [d["text"] for d in sink.events("sentence")] == ["你好。", "今天很好。"]
    assert tts.calls == ["你好。", "今天很好。"]  # 合成按句、按序
    assert [h["seq"] for h, _ in sink.frames()] == [0, 1]


def test_speakable_filter_skips_punctuation_and_emoji() -> None:
    tts = FakeTTSProvider()
    provider = ScriptedProvider(["……😀😀。你好呀。"])
    sink = run_turn(provider, voice=VoiceOut(tts))

    assert [d["text"] for d in sink.events("sentence")] == ["你好呀。"]
    assert tts.calls == ["你好呀。"]
    assert len(sink.frames()) == 1


def test_empty_reply_no_voice_activity() -> None:
    tts = FakeTTSProvider()
    sink = run_turn(ScriptedProvider([]), voice=VoiceOut(tts))
    assert sink.events("sentence") == []
    assert sink.frames() == []
    assert tts.calls == []
    assert sink.events("reply_end")[0]["full_text"] == ""


# ---------------------------------------------------------------- 失败降级


def test_single_failure_skips_that_sentence_and_continues() -> None:
    """单句失败：跳过该句、对话继续，其余句正常出帧。"""
    tts = FakeTTSProvider(fail_calls={2})  # 第 2 次合成失败
    provider = ScriptedProvider(["一。二。三。"])
    sink = run_turn(provider, voice=VoiceOut(tts))

    assert tts.calls == ["一。", "二。", "三。"]  # 每句都尝试过
    assert [h["seq"] for h, _ in sink.frames()] == [0, 2]  # 第 2 句缺失
    assert sink.events("error") == []  # 未达阈值，不报错
    assert sink.events("reply_end")[0]["full_text"] == "一。二。三。"


def test_consecutive_failures_disable_tts_and_emit_error_once() -> None:
    """连续失败达阈值：本次连接内停用 TTS，推一次非 fatal 的 TTS_FAILED。"""
    tts = FakeTTSProvider(fail_always=True)
    voice = VoiceOut(tts)
    # 每片间隔 50ms，确保 worker 的失败处理先于下一句入队（确定性时序）
    provider = ScriptedProvider(["一。", "二。", "三。", "四。", "五。"], delay=0.05)
    sink = run_turn(provider, voice=voice)

    assert voice.available is False
    # 前 3 句尝试合成并失败；第 4、5 句：流水线停止推 sentence、不再调用 synthesize
    assert tts.calls == ["一。", "二。", "三。"]
    assert [d["index"] for d in sink.events("sentence")] == [0, 1, 2]
    assert sink.frames() == []

    errors = sink.events("error")
    assert len(errors) == 1
    assert errors[0]["code"] == "TTS_FAILED"
    assert "语音" in errors[0]["message"]
    # 对话主链路不受影响
    assert sink.events("reply_end")[0]["full_text"] == "一。二。三。四。五。"
    assert sink.types()[-1] == "state"


def test_disabled_voice_stays_silent_for_new_turns() -> None:
    """停用后新的一轮直接静默：无 sentence、无帧、不调用 provider。"""
    tts = FakeTTSProvider(fail_always=True)
    voice = VoiceOut(tts)
    for _ in range(3):  # 手工触发停用（模拟上一轮已连续失败）
        voice.report_failure("x", TtsError(TtsErrorCode.TTS_NETWORK, "boom"))
    assert voice.available is False

    sink = run_turn(ScriptedProvider(["你好。"]), voice=voice)
    assert sink.events("sentence") == []
    assert sink.frames() == []
    assert tts.calls == []
    assert sink.events("reply_end")[0]["full_text"] == "你好。"


def test_synthesize_timeout_translated_to_tts_error() -> None:
    """合成超时按单句失败降级（超时被翻译为 TtsError，不悬挂流水线）。"""
    tts = FakeTTSProvider(delay=1.0)
    voice = VoiceOut(tts, synth_timeout=0.05)
    sink = run_turn(ScriptedProvider(["你好。"]), voice=voice)

    assert tts.calls == ["你好。"]
    assert sink.frames() == []
    assert sink.events("reply_end")[0]["full_text"] == "你好。"  # 对话照常收尾
    assert sink.types()[-1] == "state"


def test_voice_out_failure_streak_semantics() -> None:
    voice = VoiceOut(FakeTTSProvider(), fail_threshold=3)
    err = TtsError(TtsErrorCode.TTS_NETWORK, "x")
    assert voice.report_failure("a", err) is False
    assert voice.available is True
    voice.report_success()  # 成功清零
    assert voice.report_failure("a", err) is False
    assert voice.report_failure("b", err) is False
    assert voice.report_failure("c", err) is True  # 恰好触达阈值
    assert voice.available is False
    assert voice.report_failure("d", err) is False  # 只触发一次


# ---------------------------------------------------------------- 打断（§7.2）


def test_interrupt_cancels_tts_and_stops_frames() -> None:
    """打断：未合成句子丢弃、合成中的帧不再推、已推的帧不受影响。"""
    tts = FakeTTSProvider(delay=0.05)
    sink = RecordingSink()
    sessions = SessionManager()
    session = sessions.start("s")
    pipeline = ChatPipeline(provider=ScriptedProvider(
        ["一。", "二。", "三。", "四。", "五。", "六。", "七。", "八。"], delay=0.01
    ))

    async def scenario() -> None:
        task = asyncio.create_task(
            pipeline.run_turn(
                sink, session=session, user_text="讲个长的", voice=VoiceOut(tts)
            )
        )
        # 等到至少 1 个音频帧推出（TTS 已真实开始工作）
        for _ in range(200):
            if sink.frames():
                break
            await asyncio.sleep(0.005)
        assert sink.frames(), "TTS 未按预期开始产出帧"

        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task

        frames_at_cancel = len(sink.frames())
        await asyncio.sleep(0.3)  # 若仍有帧任务存活，这里会继续新增帧
        assert len(sink.frames()) == frames_at_cancel, "打断后仍在推音频帧"
        # worker 已彻底停止（无 tts- 后台任务残留）
        leftovers = [t for t in asyncio.all_tasks() if t.get_name().startswith("tts-")]
        assert leftovers == []

    asyncio.run(scenario())

    # 打断收尾：reply_end{interrupted} 与 state:idle
    reply_end = sink.events("reply_end")[0]
    assert reply_end["interrupted"] is True
    assert sink.types()[-1] == "state"
    assert sink.events("state")[-1]["state"] == "idle"
    # 未合成完的句子数 < 全部句子数（确实被取消，而非全部跑完）
    assert len(sink.frames()) < 8


def test_interrupt_during_finish_wait() -> None:
    """流已结束、流水线正在等待 TTS 排空时打断：合成中的帧被丢弃并以 interrupted 收尾。"""
    tts = FakeTTSProvider(delay=0.2)
    sink = RecordingSink()
    sessions = SessionManager()
    session = sessions.start("s")
    pipeline = ChatPipeline(provider=ScriptedProvider(["一句完整的话。"]))

    async def scenario() -> None:
        task = asyncio.create_task(
            pipeline.run_turn(sink, session=session, user_text="讲", voice=VoiceOut(tts))
        )
        # 等 sentence 推出后稍候，确保流水线进入 finish() 等待窗口
        for _ in range(200):
            if sink.events("sentence"):
                break
            await asyncio.sleep(0.005)
        await asyncio.sleep(0.03)
        assert not task.done(), "流水线不应在音频合成完成前结束"

        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        await asyncio.sleep(0.3)
        assert sink.frames() == []  # 合成中的句子被取消，帧未推出
        leftovers = [t for t in asyncio.all_tasks() if t.get_name().startswith("tts-")]
        assert leftovers == []

    asyncio.run(scenario())

    assert sink.events("reply_end")[0]["interrupted"] is True
    assert sink.events("state")[-1]["state"] == "idle"


# ---------------------------------------------------------------- 无语音装配


def test_no_voice_keeps_phase1_event_surface() -> None:
    """未装配语音：不推 sentence、不推二进制帧（Phase 1 行为完全不变）。"""
    sink = run_turn(ScriptedProvider(["你好。今天很好。"]))
    assert sink.frames() == []
    assert "sentence" not in sink.types()
    assert set(sink.types()[2:-2]) <= {"token", "emotion"}
