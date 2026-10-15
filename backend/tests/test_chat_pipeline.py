"""application/chat_pipeline.py 单测。

覆盖：事件顺序（§7.1）、标签跨片段、多轮历史注入、缺标签容忍（默认 neutral）、
LLM 失败收尾（reply_end + error + idle）、中断收尾（§7.2）、白名单过滤、
state:thinking 先于请求推送。
"""

from __future__ import annotations

import asyncio
from typing import Any

import pytest

from backend.application.chat_pipeline import ChatPipeline
from backend.application.session import SessionManager
from backend.modules.chat.emotion import EmotionPart, EmotionTagParser, TextPart
from backend.modules.llm.provider import Chunk
from backend.shared.errors import LlmError, LlmErrorCode
from fakes import (
    ECHO_CHUNK_SIZE,
    ECHO_REPLY,
    EchoLLMProvider,
    ScriptedProvider,
    split_chunks,
)


class FakeSink:
    """收集事件序列的测试替身（实现 ReplySink 端口）。"""

    def __init__(self) -> None:
        self.events: list[tuple[str, dict[str, Any]]] = []

    async def state(self, state: str) -> None:
        self.events.append(("state", {"state": state}))

    async def reply_start(self, message_id: str) -> None:
        self.events.append(("reply_start", {"message_id": message_id}))

    async def token(self, message_id: str, text: str) -> None:
        self.events.append(("token", {"message_id": message_id, "text": text}))

    async def emotion(self, message_id: str, emotion: str, intensity: float) -> None:
        self.events.append(
            ("emotion", {"message_id": message_id, "emotion": emotion, "intensity": intensity})
        )

    async def reply_end(
        self, message_id: str, full_text: str, *, interrupted: bool = False
    ) -> None:
        self.events.append(
            ("reply_end", {"message_id": message_id, "full_text": full_text, "interrupted": interrupted})
        )

    async def error(self, code: str, message: str) -> None:
        self.events.append(("error", {"code": code, "message": message}))

    def types(self) -> list[str]:
        return [t for t, _ in self.events]

    def data_of(self, msg_type: str) -> list[dict[str, Any]]:
        return [d for t, d in self.events if t == msg_type]


def run_turn(
    provider: Any,
    sessions: SessionManager | None = None,
    *,
    session_id: str = "test",
    user_text: str = "你好",
) -> tuple[FakeSink, SessionManager]:
    """跑一轮对话；传入同一 SessionManager 可跨轮复用会话（多轮测试用）。"""
    sessions = sessions if sessions is not None else SessionManager()
    session = sessions.start(session_id)
    sink = FakeSink()
    pipeline = ChatPipeline(provider=provider)
    asyncio.run(pipeline.run_turn(sink, session=session, user_text=user_text))
    return sink, sessions


# ---------------------------------------------------------------- 正常一轮


def test_event_order_follows_design_sequence() -> None:
    sink, _ = run_turn(ScriptedProvider(["你好呀<emo:happy>！"]))
    types = sink.types()

    assert types[0] == "state"
    assert sink.events[0][1]["state"] == "thinking"
    assert types[1] == "reply_start"
    assert types[-2] == "reply_end"
    assert types[-1] == "state"
    assert sink.events[-1][1]["state"] == "idle"
    # 中间只有流式事件
    assert set(types[2:-2]) <= {"token", "emotion"}


def test_state_thinking_pushed_before_llm_request() -> None:
    """§7.1 前置约束：发请求前必须已推 state:thinking（推理模型思考耗时真实存在）。"""
    sink = FakeSink()
    sessions = SessionManager()
    session = sessions.start("probe")

    class ProbeProvider:
        """在"发起请求"时刻断言 thinking 已推送。"""

        async def stream_chat(self, messages: Any, **opts: Any):
            assert sink.events[0] == ("state", {"state": "thinking"}), "请求发起时 thinking 未推送"
            yield Chunk(text="我在")

    asyncio.run(ChatPipeline(provider=ProbeProvider()).run_turn(
        sink, session=session, user_text="在吗"
    ))
    assert sink.types()[-2:] == ["reply_end", "state"]


def test_tokens_join_to_full_text_without_tag_residue() -> None:
    sink, _ = run_turn(EchoLLMProvider(delay=0.0))
    full = "".join(d["text"] for d in sink.data_of("token"))
    reply_end = sink.data_of("reply_end")[0]

    assert full == reply_end["full_text"]
    assert "<emo" not in full and ">" not in full
    assert reply_end["full_text"] == "你好呀！我是小兔。今天过得怎么样？唔……让我想想。我随时都在这里陪你哦。"


def test_emotion_sequence_and_message_id_consistency() -> None:
    sink, _ = run_turn(EchoLLMProvider(delay=0.0))
    emotions = [d["emotion"] for d in sink.data_of("emotion")]
    assert emotions == ["happy", "thinking", "neutral"]

    reply_ids = {
        d["message_id"]
        for t, d in sink.events
        if t in {"reply_start", "token", "emotion", "reply_end"}
    }
    assert len(reply_ids) == 1


def test_emotion_events_interleaved_in_order() -> None:
    """情绪事件必须按出现顺序穿插在 token 流中间（顺序保真）。"""
    sink, _ = run_turn(EchoLLMProvider(delay=0.0))
    flow = [t for t, _ in sink.events if t in {"token", "emotion"}]
    first_emotion = flow.index("emotion")
    assert flow[first_emotion] == "emotion"
    assert "token" in flow[first_emotion + 1 :]  # 情绪之后仍有 token（不是全部堆在末尾）


# ---------------------------------------------------------------- 标签缺失容忍


def test_missing_emotion_tags_defaults_to_neutral() -> None:
    """模型不输出标签时：不报错，补一个显式 neutral（默认情绪）。"""
    sink, _ = run_turn(ScriptedProvider(["你好呀", "，我是小兔。"]))
    emotions = [d["emotion"] for d in sink.data_of("emotion")]
    assert emotions == ["neutral"]
    assert sink.data_of("reply_end")[0]["full_text"] == "你好呀，我是小兔。"


def test_neutral_not_appended_when_tags_present() -> None:
    sink, _ = run_turn(ScriptedProvider(["<emo:happy>哈哈！"]))
    assert [d["emotion"] for d in sink.data_of("emotion")] == ["happy"]


def test_half_tag_at_stream_end_spills_as_plain_text() -> None:
    """流结束时的残留半标签按普通文本吐出（§4.2）。"""
    sink, _ = run_turn(ScriptedProvider(["你好<emo:ha"]))
    full = sink.data_of("reply_end")[0]["full_text"]
    assert full == "你好<emo:ha"
    # 半标签没有变成情绪事件，且没有自造情绪
    assert [d["emotion"] for d in sink.data_of("emotion")] == ["neutral"]


# ---------------------------------------------------------------- 多轮历史


def test_multi_turn_history_is_kept_and_replayed() -> None:
    """连续两轮：第二轮请求的 messages 应含 system + 第一轮原文 + 本轮输入。"""
    provider = ScriptedProvider(["第一轮回复"])
    _, sessions = run_turn(provider, user_text="第一轮问题")
    _, sessions = run_turn(provider, sessions, user_text="第二轮问题")

    assert len(provider.seen_messages) == 2
    first_request, second_request = provider.seen_messages

    # 第一轮：system + 本轮用户输入
    assert [m.role for m in first_request] == ["system", "user"]
    assert "小兔" in first_request[0].content  # system 含人格
    assert first_request[1].content == "第一轮问题"

    # 第二轮：system + 第一轮 user/assistant + 第二轮 user
    assert [m.role for m in second_request] == ["system", "user", "assistant", "user"]
    assert second_request[1].content == "第一轮问题"
    assert second_request[2].content == "第一轮回复"
    assert second_request[3].content == "第二轮问题"


def test_interrupted_turn_records_partial_assistant_text() -> None:
    """中断后：已产出的半截回复进入历史（用户已看到），下一轮可见。"""
    provider = ScriptedProvider(["第一段", "第二段", "第三段"], delay=0.05)
    sessions = SessionManager()
    session = sessions.start("s")

    async def scenario() -> None:
        pipeline = ChatPipeline(provider=provider)
        sink = FakeSink()
        task = asyncio.create_task(pipeline.run_turn(sink, session=session, user_text="问"))
        # 等第一个 token 真正产出（避免固定 sleep 的时序脆弱）
        for _ in range(200):
            if any(t == "token" for t in sink.types()):
                break
            await asyncio.sleep(0.005)
        assert any(t == "token" for t in sink.types()), "流式输出未按预期开始"
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task

    asyncio.run(scenario())

    roles = [m.role for m in session.recent_messages()]
    assert roles == ["user", "assistant"]  # 半截回复已入历史
    assert session.recent_messages()[1].content == "第一段"  # 且只含已产出的部分


# ---------------------------------------------------------------- LLM 失败收尾


def test_llm_error_mid_stream_recovers_with_partial_text() -> None:
    error = LlmError(LlmErrorCode.LLM_RATE_LIMIT, "触发服务商限流（429），请稍后重试")
    provider = ScriptedProvider(["先出一部分", "<emo:happy>然后"], mid_error=error)
    sink, _ = run_turn(provider)

    assert sink.types()[-3:] == ["reply_end", "error", "state"]
    assert sink.events[-1][1]["state"] == "idle"
    assert sink.data_of("reply_end")[0]["full_text"] == "先出一部分然后"
    err = sink.data_of("error")[0]
    assert err["code"] == "LLM_RATE_LIMIT"
    assert "限流" in err["message"]


def test_llm_error_at_start_no_content() -> None:
    error = LlmError(LlmErrorCode.LLM_NO_KEY, "未配置 LLM API key，请在设置中填写后再试")
    provider = ScriptedProvider(start_error=error)
    sink, sessions = run_turn(provider)

    types = sink.types()
    assert types[0] == "state" and types[1] == "reply_start"
    assert types[-3:] == ["reply_end", "error", "state"]
    assert sink.data_of("reply_end")[0]["full_text"] == ""
    assert sink.data_of("error")[0]["code"] == "LLM_NO_KEY"
    # 失败轮次：user 保留、无空 assistant 消息
    session = sessions.get("test")
    assert session is not None
    assert [m.role for m in session.recent_messages()] == ["user"]


# ---------------------------------------------------------------- Echo 分片性质


def test_echo_chunks_split_emotion_tag_in_the_middle() -> None:
    """Echo 固定回复的分片必须把 <emo:happy> 切在中间（跨片段解析的验证前提）。"""
    chunks = split_chunks(ECHO_REPLY, ECHO_CHUNK_SIZE)
    assert "".join(chunks) == ECHO_REPLY

    tag = "<emo:happy>"
    start = ECHO_REPLY.index(tag)
    end = start + len(tag)
    boundaries = [b for b in range(ECHO_CHUNK_SIZE, len(ECHO_REPLY), ECHO_CHUNK_SIZE) if start < b < end]
    assert len(boundaries) >= 2, "标签应跨三个片段（两个内部边界）"

    # 且该分片喂给解析器依然能正确还原（端到端性质）
    parser = EmotionTagParser()
    parts = []
    for chunk in chunks:
        parts.extend(parser.feed(chunk))
    parts.extend(parser.flush())
    assert [p.emotion for p in parts if isinstance(p, EmotionPart)] == ["happy", "thinking", "neutral"]
    assert "".join(p.text for p in parts if isinstance(p, TextPart)).startswith("你好呀！")


# ---------------------------------------------------------------- 中断收尾（§7.2）


def test_interrupt_ends_with_interrupted_reply() -> None:
    sink = FakeSink()
    pipeline = ChatPipeline(provider=EchoLLMProvider(delay=0.01))
    sessions = SessionManager()
    session = sessions.start("s")

    async def scenario() -> None:
        task = asyncio.create_task(pipeline.run_turn(sink, session=session, user_text="hi"))
        await asyncio.sleep(0.05)  # 等流水线进入流式阶段
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task

    asyncio.run(scenario())

    assert sink.types()[-2] == "reply_end"
    assert sink.events[-2][1]["interrupted"] is True
    assert sink.events[-1] == ("state", {"state": "idle"})
    # 中断时已产出的部分文本与 token 拼接一致
    partial = "".join(d["text"] for d in sink.data_of("token"))
    assert sink.data_of("reply_end")[0]["full_text"] == partial
    # 且确实没有跑完整篇回复（干净全文 = 原文去掉 3 个情绪标签）
    full_len = len(ECHO_REPLY) - sum(len(t) for t in ("<emo:happy>", "<emo:thinking>", "<emo:neutral>"))
    assert 0 < len(partial) < full_len


# ---------------------------------------------------------------- 白名单过滤


def test_unknown_emotion_tag_filtered_out() -> None:
    sink, _ = run_turn(EchoLLMProvider(reply="嗨<emo:excited>！<emo:happy>真好", delay=0.0))
    assert [d["emotion"] for d in sink.data_of("emotion")] == ["happy"]
    assert sink.data_of("reply_end")[0]["full_text"] == "嗨！真好"
