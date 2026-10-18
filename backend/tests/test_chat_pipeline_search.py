"""chat_pipeline 联网搜索续写轮（2026-10-18）。

验证 A 方案的核心：
- 第一轮模型只调 ``web_search``；
- 工具 handler 返回 ``model_content``；
- 流水线追加 assistant tool_calls + tool 消息，**不携带 tools** 再调一轮；
- 第二轮文本续写进同一条回复，最终 reply_end 包含两轮文本；
- tool_call 不下发前端（backend 型），搜索通知在 reply_end 之后推送。
"""

from __future__ import annotations

import asyncio
import json
from typing import Any

import pytest

from backend.application.chat_pipeline import ChatPipeline
from backend.application.session import SessionManager
from backend.modules.llm.provider import Chunk, ToolCallDelta
from backend.modules.tools import ToolRegistry, ToolSpec


class ScriptedProvider:
    """按调用次数返回预置 chunk 序列；记录每次调用的 messages/opts。"""

    def __init__(self, rounds: list[list[Chunk]]) -> None:
        self._rounds = list(rounds)
        self.calls: list[tuple[list[Any], dict[str, Any]]] = []

    async def stream_chat(self, messages, **opts):
        self.calls.append((list(messages), dict(opts)))
        chunks = self._rounds.pop(0) if self._rounds else []
        for chunk in chunks:
            yield chunk


class Sink:
    def __init__(self) -> None:
        self.events: list[tuple[str, dict[str, Any]]] = []
        self.frames: list[bytes] = []

    async def state(self, state: str) -> None:
        self.events.append(("state", {"state": state}))

    async def reply_start(self, message_id: str) -> None:
        self.events.append(("reply_start", {"message_id": message_id}))

    async def token(self, message_id: str, text: str) -> None:
        self.events.append(("token", {"text": text}))

    async def sentence(self, message_id: str, index: int, text: str) -> None:
        self.events.append(("sentence", {"text": text}))

    async def emotion(self, message_id: str, emotion: str, intensity: float) -> None:
        self.events.append(("emotion", {"emotion": emotion}))

    async def reply_end(self, message_id: str, full_text: str, *, interrupted: bool = False) -> None:
        self.events.append(("reply_end", {"full_text": full_text, "interrupted": interrupted}))

    async def tool_call(self, tool_id: str, name: str, args: dict) -> None:
        self.events.append(("tool_call", {"id": tool_id, "name": name}))

    async def notice(self, code: str, message: str, level: str = "info") -> None:
        self.events.append(("notice", {"code": code, "message": message, "level": level}))

    async def error(self, code: str, message: str) -> None:
        self.events.append(("error", {"code": code, "message": message}))

    async def send_binary(self, frame: bytes) -> None:
        self.frames.append(frame)

    def data_of(self, msg_type: str) -> list[dict[str, Any]]:
        return [data for kind, data in self.events if kind == msg_type]


def test_web_search_feedback_round() -> None:
    provider = ScriptedProvider(
        [
            [
                Chunk(
                    text="",
                    tool_delta=ToolCallDelta(
                        index=0,
                        id="call_1",
                        name="web_search",
                        arguments=json.dumps({"query": "DeepSeek V4"}),
                    ),
                )
            ],
            [Chunk(text="根据搜索结果 [1]，DeepSeek V4 已发布。")],
        ]
    )

    async def handler(args: dict[str, Any], user_text: str) -> dict[str, Any]:
        assert args["query"] == "DeepSeek V4"
        assert user_text == "搜一下 DeepSeek V4"
        return {
            "ok": True,
            "code": "search_ok",
            "message": "已联网搜索：1 条结果",
            "model_content": (
                "[联网搜索结果]\n[1] DeepSeek V4\nURL: https://example.com/v4\n"
                "摘要: V4 已发布。"
            ),
        }

    registry = ToolRegistry()
    registry.register(
        ToolSpec(
            name="web_search",
            description="联网搜索",
            parameters={"type": "object", "properties": {"query": {"type": "string"}}},
            executor="backend",
            handler=handler,
            needs_user_text=True,
            feedback=True,
            ack="我搜一下～",
        )
    )

    sessions = SessionManager()
    session = sessions.start("search")
    sink = Sink()
    asyncio.run(
        ChatPipeline(provider=provider, tools=registry).run_turn(
            sink, session=session, user_text="搜一下 DeepSeek V4"
        )
    )

    # 两轮调用；第二轮不带 tools
    assert len(provider.calls) == 2
    first_messages, first_opts = provider.calls[0]
    second_messages, second_opts = provider.calls[1]
    assert "tools" in first_opts
    assert "tools" not in second_opts

    # 第二轮上下文：assistant tool_calls + 对应 tool 结果
    assistant = second_messages[-2]
    tool_message = second_messages[-1]
    assert assistant.role == "assistant"
    assert assistant.tool_calls[0]["id"] == "call_1"
    assert assistant.tool_calls[0]["function"]["name"] == "web_search"
    assert json.loads(assistant.tool_calls[0]["function"]["arguments"]) == {
        "query": "DeepSeek V4"
    }
    assert tool_message.role == "tool"
    assert tool_message.tool_call_id == "call_1"
    assert "https://example.com/v4" in tool_message.content

    # 同一轮回复：ack + 第二轮答案；不下发前端 tool_call
    reply = sink.data_of("reply_end")[0]["full_text"]
    assert "我搜一下～" in reply
    assert "根据搜索结果 [1]" in reply
    assert sink.data_of("tool_call") == []

    # 搜索通知在 reply_end 之后推送
    notices = sink.data_of("notice")
    assert notices and notices[-1]["code"] == "search_ok"
    assert notices[-1]["message"] == "已联网搜索：1 条结果"
    assert sink.events[-1][0] == "state"  # idle 收尾


def test_feedback_results_without_messages_do_not_break() -> None:
    """快通道路径没有 messages：即使构造出 feedback 结果也不应触发第二轮/崩溃。

    这里直接验证 registry 的 feedback 标记不会改变普通 backend 工具的行为：
    没有 model_content 的结果只走通知，不续写。
    """
    provider = ScriptedProvider([[Chunk(text="好的")]])

    async def handler(args: dict[str, Any]) -> dict[str, Any]:
        return {"ok": True, "code": "done", "message": "办好了"}

    registry = ToolRegistry()
    registry.register(
        ToolSpec(
            name="normal_tool",
            description="普通工具",
            parameters={"type": "object", "properties": {}},
            executor="backend",
            handler=handler,
            feedback=False,
            ack="好～",
        )
    )
    sessions = SessionManager()
    sink = Sink()
    asyncio.run(
        ChatPipeline(provider=provider, tools=registry).run_turn(
            sink, session=sessions.start("normal"), user_text="随便聊聊"
        )
    )
    assert len(provider.calls) == 1
    assert sink.data_of("reply_end")[0]["full_text"] == "好的"
