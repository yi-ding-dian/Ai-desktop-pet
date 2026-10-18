"""chat_pipeline 工具机制（§4.7）单测：快通道 / 模型 tool_calls / 降级链。

覆盖：
- 快通道：命中指令词表 → provider 零调用、事件序列完整（含 tool_call）、
  user + assistant 照常落库（happy 情绪入 messages.emotion）；未命中 →
  走 LLM 正常流且 tools 已透传；未装配注册表 → 旧行为零回归；
- 模型路径：tool_deltas 分片归组拼接（含"仅 tool_calls 无正文"的真机场景）→
  reply_end 之后派发 tool_call；无正文时用 spec.ack 补话（token/full_text/
  落库/TTS 可播报），有正文时不补；
- 降级：LLM_BAD_REQUEST 且本轮无产出 → 摘 tools 重放，进程级标记置位后
  后续轮不再带 tools；快通道不受影响；重放再败以第一次错误收尾；
  有产出 / 其他错误码不触发降级；
- 稳健性：坏 JSON 参数 / 未知工具 / 多调用按 index 序；
- WS sink：ConnectionContext.tool_call 的事件格式（ReplySink 端口，§4.7）。
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any, Iterator

import pytest

from backend.application.chat_pipeline import (
    ChatPipeline,
    _FALLBACK_ACK,
    _reset_tools_support_state,
)
from backend.application.session import SessionManager
from backend.application.voice import VoiceOut
from backend.interfaces.ws.server import ConnectionContext
from backend.modules.chat.history import HistoryStore
from backend.modules.llm.provider import ToolCallDelta
from backend.modules.tools import ToolRegistry, ToolSpec, build_default_registry
from backend.shared.db import connect_db
from backend.shared.errors import LlmError, LlmErrorCode
from fakes import FakeLLMProvider, FakeTTSProvider


@pytest.fixture(autouse=True)
def _isolate_tools_support_state() -> Iterator[None]:
    """用例间隔离进程级降级标记（_tools_unsupported 是模块变量）。"""
    _reset_tools_support_state()
    yield
    _reset_tools_support_state()


class ToolSink:
    """收集事件序列的测试替身（实现 ReplySink 端口，含 tool_call / send_binary）。"""

    def __init__(self) -> None:
        self.events: list[tuple[str, dict[str, Any]]] = []
        self.frames: list[bytes] = []

    async def state(self, state: str) -> None:
        self.events.append(("state", {"state": state}))

    async def reply_start(self, message_id: str) -> None:
        self.events.append(("reply_start", {"message_id": message_id}))

    async def reasoning(self, message_id: str, text: str) -> None:
        self.events.append(("reasoning", {"message_id": message_id, "text": text}))

    async def token(self, message_id: str, text: str) -> None:
        self.events.append(("token", {"message_id": message_id, "text": text}))

    async def sentence(self, message_id: str, index: int, text: str) -> None:
        self.events.append(
            ("sentence", {"message_id": message_id, "index": index, "text": text})
        )

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

    async def tool_call(self, tool_id: str, name: str, args: dict) -> None:
        self.events.append(("tool_call", {"id": tool_id, "name": name, "args": args}))

    async def notice(self, code: str, message: str, level: str = "info") -> None:
        self.events.append(("notice", {"code": code, "message": message, "level": level}))

    async def error(self, code: str, message: str) -> None:
        self.events.append(("error", {"code": code, "message": message}))

    async def send_binary(self, frame: bytes) -> None:
        self.frames.append(frame)

    def types(self) -> list[str]:
        return [t for t, _ in self.events]

    def data_of(self, msg_type: str) -> list[dict[str, Any]]:
        return [d for t, d in self.events if t == msg_type]


def run_turn(
    provider: Any,
    *,
    tools: ToolRegistry | None,
    user_text: str,
    voice: VoiceOut | None = None,
    sessions: SessionManager | None = None,
    session_id: str = "tools",
) -> tuple[ToolSink, SessionManager]:
    """跑一轮对话；传同一 SessionManager 可跨轮复用（"下一轮不再带 tools"断言用）。"""
    sessions = sessions if sessions is not None else SessionManager()
    session = sessions.start(session_id)
    sink = ToolSink()
    asyncio.run(
        ChatPipeline(provider=provider, tools=tools).run_turn(
            sink, session=session, user_text=user_text, voice=voice
        )
    )
    return sink, sessions


def open_settings_ack() -> str:
    """内置 open_settings 的确认话术（从注册表动态取，防文案变更破坏断言）。"""
    spec = build_default_registry().get("open_settings")
    assert spec is not None and spec.ack
    return spec.ack


def registry_with_demo_tool() -> ToolRegistry:
    """内置注册表 + 一个带 ack/带参数的演示工具（测 arguments 拼接与 ack 来源）。"""
    registry = build_default_registry()
    registry.register(
        ToolSpec(
            name="demo_tool",
            description="演示工具",
            parameters={"type": "object", "properties": {"q": {"type": "string"}}},
            ack="已经帮你办好啦～",
        )
    )
    return registry


# ---------------------------------------------------------------- 快通道


def test_directive_fast_path_skips_llm_and_emits_tool_call() -> None:
    """命中"打开设置"：不调 LLM，ack 走完整事件流，tool_call 在 reply_end 之后。"""
    provider = FakeLLMProvider(pieces=["不应出现"])
    sink, sessions = run_turn(provider, tools=build_default_registry(), user_text="打开设置")
    ack = open_settings_ack()

    assert provider.seen_messages == []  # 快通道：provider 零调用
    assert sink.types() == [
        "state", "reply_start", "token", "emotion", "reply_end", "tool_call", "state",
    ]
    assert sink.events[0][1]["state"] == "thinking"
    assert sink.events[-1][1]["state"] == "idle"

    # 事件内容与 message_id 一致性
    assert sink.data_of("token")[0]["text"] == ack
    assert sink.data_of("reply_end")[0]["full_text"] == ack
    assert sink.data_of("emotion")[0]["emotion"] == "happy"
    ids = {
        d["message_id"]
        for t, d in sink.events
        if t in {"reply_start", "token", "emotion", "reply_end"}
    }
    assert len(ids) == 1

    # tool_call：id 前缀 dir_（指令来源）、无参工具 args={}
    call = sink.data_of("tool_call")[0]
    assert call["name"] == "open_settings"
    assert call["args"] == {}
    assert call["id"].startswith("dir_")

    # 落库：user + assistant 两条（assistant 即 ack）
    session = sessions.get("tools")
    assert session is not None
    messages = session.recent_messages()
    assert [m.role for m in messages] == ["user", "assistant"]
    assert messages[0].content == "打开设置"
    assert messages[1].content == ack


@pytest.mark.parametrize("text", ["帮我打开设置面板呗", "设置面板在哪？"])
def test_directive_fast_path_container_match(text: str) -> None:
    """包含匹配（与迁移前前端正则行为一致）：句中带关键词也走快通道。"""
    provider = FakeLLMProvider()
    sink, _ = run_turn(provider, tools=build_default_registry(), user_text=text)
    assert provider.seen_messages == []
    assert sink.data_of("tool_call")[0]["name"] == "open_settings"


def test_directive_fast_path_persists_happy_emotion(tmp_path: Path) -> None:
    """快通道 ack 以 happy 情绪增量落库（§6.2 messages.emotion）。"""
    store = HistoryStore(connect_db(tmp_path / "pet.db"))
    sessions = SessionManager(store=store)
    sink, _ = run_turn(
        FakeLLMProvider(),
        tools=build_default_registry(),
        user_text="打开设置",
        sessions=sessions,
    )

    session = sessions.get("tools")
    assert session is not None
    rows = store.recent_messages(session.id, limit=10)
    assert [r["role"] for r in rows] == ["user", "assistant"]
    assert rows[1]["content"] == open_settings_ack()
    assert rows[1]["emotion"] == "happy"


def test_without_registry_directive_goes_to_llm_without_tools() -> None:
    """未注入 tools（旧装配）：命中词表的输入也照常走 LLM、请求不带 tools（零回归）。"""
    provider = FakeLLMProvider(pieces=["好的"])
    sink, _ = run_turn(provider, tools=None, user_text="打开设置")

    assert len(provider.seen_messages) == 1
    assert provider.seen_opts[0] == {}
    assert sink.data_of("tool_call") == []


# ---------------------------------------------------------------- 正常流（携带 tools）


def test_regular_message_carries_tools_to_provider() -> None:
    """未命中词表：走 LLM 正常流，tools 经 opts 透传给 provider。"""
    registry = build_default_registry()
    provider = FakeLLMProvider(pieces=["今天天气不错哦～", "<emo:happy>出去走走？"])
    sink, _ = run_turn(provider, tools=registry, user_text="今天天气怎么样")

    assert len(provider.seen_messages) == 1
    assert provider.seen_opts[0]["tools"] == registry.to_openai_tools()
    assert sink.data_of("tool_call") == []
    assert sink.data_of("reply_end")[0]["full_text"] == "今天天气不错哦～出去走走？"


# ---------------------------------------------------------------- 模型路径（tool_calls）


def test_model_tool_call_with_content_dispatches_after_reply_end() -> None:
    """模型"先说一句再调工具"（真机实测路径）：正文照常，tool_call 在 reply_end 之后。"""
    registry = build_default_registry()
    provider = FakeLLMProvider(
        pieces=["好嘞，这就帮你打开～"],
        tool_deltas=[
            ToolCallDelta(index=0, id="call_1", name="open_settings"),  # 首片带 id/name
            ToolCallDelta(index=0, arguments="{}"),  # 后续分片只带 arguments
        ],
    )
    sink, sessions = run_turn(
        provider, tools=registry, user_text="帮我把配置界面调出来呗"
    )

    assert sink.types()[-3:] == ["reply_end", "tool_call", "state"]
    call = sink.data_of("tool_call")[0]
    assert (call["id"], call["name"], call["args"]) == ("call_1", "open_settings", {})

    # 有正文：不补话；token 全文 / reply_end / 落库一致
    assert "".join(d["text"] for d in sink.data_of("token")) == "好嘞，这就帮你打开～"
    assert sink.data_of("reply_end")[0]["full_text"] == "好嘞，这就帮你打开～"
    session = sessions.get("tools")
    assert session is not None
    assert session.recent_messages()[-1].content == "好嘞，这就帮你打开～"
    # 工具调用本身不进对话历史（assistant 只存正文）
    assert "open_settings" not in "".join(m.content for m in session.recent_messages())


def test_model_tool_call_without_content_uses_tool_ack() -> None:
    """"内容为空、仅 tool_calls"（真机实测路径）：arguments 分片拼接 + ack 补话。"""
    registry = registry_with_demo_tool()
    provider = FakeLLMProvider(
        pieces=[],
        tool_deltas=[
            ToolCallDelta(index=0, id="call_9", name="demo_tool", arguments='{"q": "1'),
            ToolCallDelta(index=0, arguments='23"}'),
        ],
    )
    sink, sessions = run_turn(provider, tools=registry, user_text="帮我处理一下这件事")

    call = sink.data_of("tool_call")[0]
    assert (call["id"], call["name"]) == ("call_9", "demo_tool")
    assert call["args"] == {"q": "123"}  # arguments 分片拼接后解析

    ack = "已经帮你办好啦～"
    assert sink.types() == [
        "state", "reply_start", "token", "emotion", "reply_end", "tool_call", "state",
    ]
    assert [d["text"] for d in sink.data_of("token")] == [ack]  # 补话进 token（TTS 可播报）
    assert sink.data_of("reply_end")[0]["full_text"] == ack
    assert [d["emotion"] for d in sink.data_of("emotion")] == ["neutral"]
    session = sessions.get("tools")
    assert session is not None
    assert session.recent_messages()[-1].content == ack  # 补话落库


def test_bad_json_and_unknown_tool_fall_back_to_empty_args() -> None:
    """坏 JSON 按空参数派发；未注册工具用通用兜底补话（不静默、也不吞调用）。"""
    provider = FakeLLMProvider(
        tool_deltas=[
            ToolCallDelta(index=0, id="call_x", name="ghost_tool", arguments="{坏")
        ]
    )
    sink, _ = run_turn(provider, tools=build_default_registry(), user_text="帮我做点什么吧")

    call = sink.data_of("tool_call")[0]
    assert call["name"] == "ghost_tool"  # 未知工具照常派发（前端忽略未知 name）
    assert call["args"] == {}
    assert sink.data_of("token")[0]["text"] == _FALLBACK_ACK


def test_multiple_tool_calls_dispatched_in_index_order_and_ack_once() -> None:
    """并行调用按 index 序派发；无正文只补一句（用第一个 index 的 ack）。"""
    registry = registry_with_demo_tool()
    provider = FakeLLMProvider(
        tool_deltas=[
            ToolCallDelta(index=1, id="call_b", name="demo_tool", arguments="{}"),
            ToolCallDelta(index=0, id="call_a", name="open_settings", arguments="{}"),
        ]
    )
    sink, _ = run_turn(provider, tools=registry, user_text="帮我处理一下这件事")

    assert [d["name"] for d in sink.data_of("tool_call")] == ["open_settings", "demo_tool"]
    assert [d["text"] for d in sink.data_of("token")] == [open_settings_ack()]


def test_fast_path_ack_reaches_tts_via_splitter() -> None:
    """快通道 ack 同时经 on_clean_text 喂分句器：sentence 事件 + TTS 播报。"""
    tts = FakeTTSProvider()
    sink, _ = run_turn(
        FakeLLMProvider(),
        tools=build_default_registry(),
        user_text="打开设置",
        voice=VoiceOut(tts),
    )
    ack = open_settings_ack()
    assert "".join(d["text"] for d in sink.data_of("sentence")) == ack
    assert tts.calls  # 至少合成过一句（具体拆分由 splitter 决定）
    assert "".join(tts.calls) == ack


# ---------------------------------------------------------------- backend 型工具（提醒，2026-10-18）


class FakeReminderTools:
    """提醒工具服务替身：记录转发参数，可注入成功/失败结果。"""

    def __init__(self, *, result: dict[str, Any] | None = None) -> None:
        self.result = result or {
            "ok": True,
            "code": "reminder_created",
            "message": "已设置提醒 · 明天 09:00 · 交房租",
        }
        self.calls: list[dict[str, Any]] = []

    def create_from_tool(self, *, text: str, due_at: str, repeat: str) -> dict[str, Any]:
        self.calls.append({"text": text, "due_at": due_at, "repeat": repeat})
        return self.result

    def list_for_tool(self, limit: int = 20) -> dict[str, Any]:
        self.calls.append({"limit": limit})
        return self.result

    def cancel_from_tool(self, *, key: str) -> dict[str, Any]:
        self.calls.append({"key": key})
        return self.result


def reminder_registry(fake: FakeReminderTools) -> ToolRegistry:
    return build_default_registry(fake)


def reminder_tool_delta(arguments: str) -> list[ToolCallDelta]:
    return [
        ToolCallDelta(index=0, id="call_r", name="create_reminder"),
        ToolCallDelta(index=0, arguments=arguments),
    ]


def test_backend_tool_executes_and_emits_notice_not_tool_call() -> None:
    """backend 型工具：当场执行 → notice 确定性确认；不向前端派发 tool_call。"""
    fake = FakeReminderTools()
    provider = FakeLLMProvider(
        pieces=["好嘞，这就给你设上～"],
        tool_deltas=reminder_tool_delta(
            '{"text": "交房租", "due_at": "2026-10-18T09:00:00+08:00", "repeat": "none"}'
        ),
    )
    sink, _ = run_turn(
        provider, tools=reminder_registry(fake), user_text="明天 9 点提醒我交房租"
    )

    assert fake.calls == [
        {
            "text": "交房租",
            "due_at": "2026-10-18T09:00:00+08:00",
            "repeat": "none",
        }
    ]
    assert sink.data_of("tool_call") == []  # backend 工具不交前端执行
    notice = sink.data_of("notice")[0]
    assert notice["code"] == "reminder_created"
    assert notice["level"] == "info"
    assert "已设置提醒" in notice["message"]
    # 工具已真正返回：不应再补“没设上”警示
    assert all(n["code"] != "reminder_tool_missed" for n in sink.data_of("notice"))
    # 模型有正文：不补 ack，正文照常
    assert sink.data_of("reply_end")[0]["full_text"] == "好嘞，这就给你设上～"


def test_backend_tool_failure_without_content_speaks_failure_message() -> None:
    """模型只调工具且执行失败：补话必须是失败原因，不能把失败说成成功。"""
    fake = FakeReminderTools(
        result={
            "ok": False,
            "code": "reminder_error",
            "message": "提醒没设上：提醒时间必须晚于现在（至少 10 秒后）",
        }
    )
    provider = FakeLLMProvider(
        pieces=[],
        tool_deltas=reminder_tool_delta(
            '{"text": "交房租", "due_at": "2026-10-17T09:00:00+08:00"}'
        ),
    )
    sink, _ = run_turn(provider, tools=reminder_registry(fake), user_text="提醒我交房租")

    expected = "提醒没设上：提醒时间必须晚于现在（至少 10 秒后）"
    assert [d["text"] for d in sink.data_of("token")] == [expected]
    assert sink.data_of("reply_end")[0]["full_text"] == expected
    notice = sink.data_of("notice")[0]
    assert notice["code"] == "reminder_error"
    assert notice["level"] == "warn"


def test_backend_tool_failure_with_content_keeps_model_text() -> None:
    """模型已经说了话：notice 照常给出失败原因，但不覆盖模型正文。"""
    fake = FakeReminderTools(
        result={"ok": False, "code": "reminder_error", "message": "提醒没设上：时间太远"}
    )
    provider = FakeLLMProvider(
        pieces=["我试试看～"],
        tool_deltas=reminder_tool_delta('{"text": "交房租", "due_at": "2099-01-01"}'),
    )
    sink, _ = run_turn(provider, tools=reminder_registry(fake), user_text="提醒我")

    assert sink.data_of("reply_end")[0]["full_text"] == "我试试看～"
    assert sink.data_of("notice")[0]["message"] == "提醒没设上：时间太远"


def test_reminder_intent_forces_tool_choice() -> None:
    """动作 + 明确时间 → 请求带 tool_choice（模型只回文字时也会被迫调用工具）。"""
    fake = FakeReminderTools()
    provider = FakeLLMProvider(pieces=["好，提醒你睡觉～"])
    sink, _ = run_turn(
        provider,
        tools=reminder_registry(fake),
        user_text="1分钟后提醒我睡觉",
    )

    assert provider.seen_opts[0]["tool_choice"] == {
        "type": "function",
        "function": {"name": "create_reminder"},
    }
    # 假 provider 不遵守 tool_choice（模拟网关忽略）：必须给用户一条“没设上”警示，
    # 不能让模型那句“好，提醒你”变成静默失败。
    assert sink.data_of("notice")[-1]["code"] == "reminder_tool_missed"


def test_plain_reminder_without_time_does_not_force_tool_choice() -> None:
    """没给时间不强制：模型应先反问，而不是带空 due_at 去调用工具。"""
    fake = FakeReminderTools()
    provider = FakeLLMProvider(pieces=["什么时候提醒你呀？"])
    run_turn(provider, tools=reminder_registry(fake), user_text="提醒我交房租")

    assert "tool_choice" not in provider.seen_opts[0]


def test_tool_choice_rejected_retries_with_tools_only() -> None:
    """网关支持 tools 但不支持 tool_choice：先摘 tool_choice、保留 tools 重试。"""
    fake = FakeReminderTools()
    provider = FakeLLMProvider(
        pieces=["重放成功啦"],
        fail_calls={
            1: LlmError(LlmErrorCode.LLM_BAD_REQUEST, "请求被拒绝：不支持的参数 tool_choice")
        },
    )
    sink, _ = run_turn(
        provider,
        tools=reminder_registry(fake),
        user_text="1分钟后提醒我睡觉",
    )

    assert len(provider.seen_opts) == 2
    assert "tool_choice" in provider.seen_opts[0]
    assert "tool_choice" not in provider.seen_opts[1]
    assert provider.seen_opts[1]["tools"]  # tools 仍保留
    assert sink.data_of("reply_end")[0]["full_text"] == "重放成功啦"


def test_time_block_injected_only_when_reminder_tools_registered() -> None:
    """提醒工具装配后 system 注入当前时间；旧注册表（仅 open_settings）不注入。"""
    provider = FakeLLMProvider(pieces=["好"])
    run_turn(provider, tools=reminder_registry(FakeReminderTools()), user_text="随便聊聊")
    assert any(
        message.role == "system" and "用户说相对时间" in message.content
        for message in provider.seen_messages[0]
    )

    legacy = FakeLLMProvider(pieces=["好"])
    run_turn(legacy, tools=build_default_registry(), user_text="随便聊聊")
    assert not any(
        message.role == "system" and "用户说相对时间" in message.content
        for message in legacy.seen_messages[0]
    )


# ---------------------------------------------------------------- 降级链


def test_bad_request_without_output_retries_without_tools_and_marks_process() -> None:
    """LLM_BAD_REQUEST 且本轮无产出 → 摘 tools 重放；标记置位后下一轮不再带 tools。"""
    registry = build_default_registry()
    provider = FakeLLMProvider(
        pieces=["重放成功啦"],
        fail_calls={
            1: LlmError(LlmErrorCode.LLM_BAD_REQUEST, "请求被服务商拒绝：不支持的参数 tools")
        },
    )
    sessions = SessionManager()

    sink, _ = run_turn(provider, tools=registry, user_text="随便聊聊吧", sessions=sessions)

    # 调用两次：首次带 tools、重放不带
    assert len(provider.seen_opts) == 2
    assert provider.seen_opts[0]["tools"] == registry.to_openai_tools()
    assert "tools" not in provider.seen_opts[1]
    # 重放成功：本轮正常完成（无 error 事件）
    assert sink.types() == ["state", "reply_start", "token", "emotion", "reply_end", "state"]
    assert sink.data_of("reply_end")[0]["full_text"] == "重放成功啦"

    # 标记已置位：下一轮（未命中快通道）不再带 tools
    sink2, _ = run_turn(provider, tools=registry, user_text="再聊一句吧", sessions=sessions)
    assert len(provider.seen_opts) == 3
    assert "tools" not in provider.seen_opts[2]
    assert sink2.data_of("reply_end")[0]["full_text"] == "重放成功啦"


def test_fast_path_still_available_after_tools_marked_unsupported() -> None:
    """降级标记不影响快通道（不依赖模型 tools 能力）：照常零调用、派发 tool_call。"""
    registry = build_default_registry()
    provider = FakeLLMProvider(
        fail_calls={1: LlmError(LlmErrorCode.LLM_BAD_REQUEST, "不支持 tools")}
    )
    sessions = SessionManager()
    run_turn(provider, tools=registry, user_text="随便聊聊吧", sessions=sessions)
    assert len(provider.seen_opts) == 2  # 首跑 + 重放（标记已置位）

    sink, _ = run_turn(provider, tools=registry, user_text="打开设置", sessions=sessions)
    assert len(provider.seen_opts) == 2  # 快通道零调用
    assert sink.data_of("tool_call")[0]["name"] == "open_settings"


def test_retry_failure_reports_first_error() -> None:
    """重放也失败：以第一次（LLM_BAD_REQUEST）错误收尾——对用户更有指向性。"""
    provider = FakeLLMProvider(
        fail_calls={
            1: LlmError(LlmErrorCode.LLM_BAD_REQUEST, "请求被服务商拒绝：tools"),
            2: LlmError(LlmErrorCode.LLM_NETWORK, "无法连接 LLM 服务"),
        }
    )
    sink, _ = run_turn(provider, tools=build_default_registry(), user_text="随便聊聊吧")

    assert len(provider.seen_opts) == 2
    assert "tools" not in provider.seen_opts[1]
    assert sink.data_of("error")[0]["code"] == "LLM_BAD_REQUEST"
    assert sink.types()[-3:] == ["reply_end", "error", "state"]


def test_bad_request_with_partial_output_does_not_retry() -> None:
    """已有产出（文本）不满足降级条件：照常失败收尾、不重放。"""
    provider = FakeLLMProvider(
        pieces=["先出了一点话"],
        mid_error=LlmError(LlmErrorCode.LLM_BAD_REQUEST, "请求被服务商拒绝"),
    )
    sink, _ = run_turn(provider, tools=build_default_registry(), user_text="随便聊聊吧")

    assert len(provider.seen_opts) == 1  # 有产出 → 不重放
    assert sink.data_of("reply_end")[0]["full_text"] == "先出了一点话"
    assert sink.data_of("error")[0]["code"] == "LLM_BAD_REQUEST"


def test_other_error_codes_do_not_trigger_tools_retry() -> None:
    """非 LLM_BAD_REQUEST（如限流）不触发"摘 tools 重放"。"""
    provider = FakeLLMProvider(
        fail_calls={
            1: LlmError(LlmErrorCode.LLM_RATE_LIMIT, "触发服务商限流（429），请稍后重试")
        }
    )
    sink, _ = run_turn(provider, tools=build_default_registry(), user_text="随便聊聊吧")

    assert len(provider.seen_opts) == 1
    assert sink.data_of("error")[0]["code"] == "LLM_RATE_LIMIT"


# ---------------------------------------------------------------- WS sink（ReplySink 端口）


class _FakeWs:
    """假 WebSocket：只收集 send_text 原文（端口格式测试不需要真连接）。"""

    def __init__(self) -> None:
        self.sent: list[str] = []

    async def send_text(self, raw: str) -> None:
        self.sent.append(raw)


def test_connection_context_tool_call_event_shape() -> None:
    """ConnectionContext.tool_call → 协议事件 tool_call{id,name,args}（§4.7）。"""
    ctx = ConnectionContext(_FakeWs())
    asyncio.run(ctx.tool_call("call_1", "open_settings", {"q": "x"}))

    envelope = json.loads(ctx.ws.sent[0])
    assert envelope["type"] == "tool_call"
    assert envelope["data"] == {"id": "call_1", "name": "open_settings", "args": {"q": "x"}}


# ---------------------------------------------------------------- 记忆本前置解析（2026-10-18）


def test_prepare_resolves_frontend_tool_args() -> None:
    """prepare 成功：用解析后的参数派发前端 tool_call（名字 → 精确值）。"""
    registry = ToolRegistry()
    registry.register(
        ToolSpec(
            name="open_item",
            description="",
            parameters={"type": "object", "properties": {}},
            executor="frontend",
            prepare=lambda args, user_text: {
                "ok": True,
                "args": {
                    "kind": "link",
                    "value": "https://resolved",
                    "user_text": user_text,
                },
            },
        )
    )
    pipeline = ChatPipeline(FakeLLMProvider(), tools=registry)
    frontend, backend = asyncio.run(
        pipeline._execute_tool_calls(
            [("t1", "open_item", {"name": "博客"})], "打开博客"
        )
    )
    assert backend == []
    assert frontend == [
        (
            "t1",
            "open_item",
            {"kind": "link", "value": "https://resolved", "user_text": "打开博客"},
        )
    ]


def test_prepare_failure_becomes_backend_notice() -> None:
    """prepare 失败：不派发前端，按后端结果发通知（找不到条目/路径失效等）。"""
    registry = ToolRegistry()
    registry.register(
        ToolSpec(
            name="open_item",
            description="",
            parameters={"type": "object", "properties": {}},
            executor="frontend",
            prepare=lambda args, user_text: {
                "ok": False,
                "code": "item_not_found",
                "message": "记忆本里没有这条",
            },
        )
    )
    pipeline = ChatPipeline(FakeLLMProvider(), tools=registry)
    frontend, backend = asyncio.run(
        pipeline._execute_tool_calls([("t1", "open_item", {"name": "x"})], "打开 x")
    )
    assert frontend == []
    assert backend == [
        (
            "open_item",
            {"ok": False, "code": "item_not_found", "message": "记忆本里没有这条"},
        )
    ]


def test_backend_tool_receives_user_text_when_needed() -> None:
    """needs_user_text=True 的 handler 拿到用户本轮原话（删记录点名保护）。"""
    registry = ToolRegistry()
    registry.register(
        ToolSpec(
            name="delete_item",
            description="",
            parameters={"type": "object", "properties": {}},
            executor="backend",
            needs_user_text=True,
            handler=lambda args, user_text: {
                "ok": True,
                "code": "items_deleted",
                "message": f"user_text={user_text}",
            },
        )
    )
    pipeline = ChatPipeline(FakeLLMProvider(), tools=registry)
    _frontend, backend = asyncio.run(
        pipeline._execute_tool_calls(
            [("t1", "delete_item", {"names": ["博客"]})], "忘掉博客"
        )
    )
    assert backend[0][1]["message"] == "user_text=忘掉博客"
