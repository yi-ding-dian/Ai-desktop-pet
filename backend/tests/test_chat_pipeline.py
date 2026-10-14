"""application/chat_pipeline.py 单测：事件顺序、标签跨片段、中断收尾、白名单过滤。"""

from __future__ import annotations

import asyncio
from typing import Any

import pytest

from backend.application.chat_pipeline import (
    ECHO_CHUNK_SIZE,
    ECHO_REPLY,
    ChatPipeline,
    EchoLLMProvider,
    split_chunks,
)
from backend.modules.chat.emotion import EmotionPart, EmotionTagParser, TextPart


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

    def types(self) -> list[str]:
        return [t for t, _ in self.events]

    def data_of(self, msg_type: str) -> list[dict[str, Any]]:
        return [d for t, d in self.events if t == msg_type]


def run_turn(provider: EchoLLMProvider | None = None) -> FakeSink:
    sink = FakeSink()
    pipeline = ChatPipeline(provider or EchoLLMProvider(delay=0.0))
    asyncio.run(pipeline.run_turn(sink, session_id="test", user_text="你好"))
    return sink


# ---------------------------------------------------------------- 正常一轮


def test_event_order_follows_design_sequence() -> None:
    sink = run_turn()
    types = sink.types()

    assert types[0] == "state"
    assert sink.events[0][1]["state"] == "thinking"
    assert types[1] == "reply_start"
    assert types[-2] == "reply_end"
    assert types[-1] == "state"
    assert sink.events[-1][1]["state"] == "idle"
    # 中间只有流式事件
    assert set(types[2:-2]) <= {"token", "emotion"}


def test_tokens_join_to_full_text_without_tag_residue() -> None:
    sink = run_turn()
    full = "".join(d["text"] for d in sink.data_of("token"))
    reply_end = sink.data_of("reply_end")[0]

    assert full == reply_end["full_text"]
    assert "<emo" not in full and ">" not in full
    assert reply_end["full_text"] == "你好呀！我是小豆。今天过得怎么样？唔……让我想想。我随时都在这里陪你哦。"


def test_emotion_sequence_and_message_id_consistency() -> None:
    sink = run_turn()
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
    sink = run_turn()
    flow = [t for t, _ in sink.events if t in {"token", "emotion"}]
    first_emotion = flow.index("emotion")
    assert flow[first_emotion] == "emotion"
    assert "token" in flow[first_emotion + 1 :]  # 情绪之后仍有 token（不是全部堆在末尾）


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
    pipeline = ChatPipeline(EchoLLMProvider(delay=0.01))

    async def scenario() -> None:
        task = asyncio.create_task(pipeline.run_turn(sink, session_id="s", user_text="hi"))
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
    assert full_len > len(partial)


# ---------------------------------------------------------------- 白名单过滤


def test_unknown_emotion_tag_filtered_out() -> None:
    sink = run_turn(EchoLLMProvider(reply="嗨<emo:excited>！<emo:happy>真好", delay=0.0))
    assert [d["emotion"] for d in sink.data_of("emotion")] == ["happy"]
    assert sink.data_of("reply_end")[0]["full_text"] == "嗨！真好"
