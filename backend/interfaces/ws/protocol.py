"""WS 协议 v1：消息信封 + 全部事件数据模型 + 序列化/反序列化 + 版本校验。

对应设计文档 §3（§3.1 信封、§3.2 客户端事件、§3.3 服务端事件）。
本文件是协议的唯一事实来源；后续可用脚本从这里生成前端 TS 类型（§10 待办 #7）。

说明：客户端事件表在 §3.2 之外补了 ``ping``（依据 §3.6 心跳约定）；
``audio_chunk`` / ``audio`` 为 Phase 2 二进制帧（§3.5），文本帧侧仅保留占位模型。
"""

from __future__ import annotations

import json
import time
import uuid
from dataclasses import dataclass
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator

from backend.shared.errors import ErrorCode, ProtocolError

PROTOCOL_VERSION = 1


class EventData(BaseModel):
    """事件 data 模型基类：对未知字段宽容（协议演进时向后兼容）。"""

    model_config = ConfigDict(extra="ignore")


class Envelope(BaseModel):
    """消息信封（§3.1）：v / id / reply_to / type / ts / data。"""

    model_config = ConfigDict(extra="ignore")

    v: int = PROTOCOL_VERSION
    id: str
    reply_to: str | None = None
    type: str
    ts: int = Field(default_factory=lambda: int(time.time() * 1000))
    data: dict[str, Any] = Field(default_factory=dict)

    @field_validator("data", mode="before")
    @classmethod
    def _none_to_empty(cls, value: Any) -> Any:
        """容忍 data 为 null / 缺省。"""
        return {} if value is None else value


# ---------------------------------------------------------------- §3.2 客户端 → 服务端


class HelloData(EventData):
    """连接后首条消息：鉴权 + 版本协商。"""

    token: str
    protocol_version: int
    app_version: str = ""


class UserMessageData(EventData):
    """用户文字输入。"""

    text: str
    session_id: str | None = None


class PingData(EventData):
    """心跳（§3.6：前端每 30s 发 ping，服务端回 pong）。"""


class InterruptData(EventData):
    """打断：取消当前流式回复。"""


class PetEventData(EventData):
    """宠物交互事件（tap_head / drag_end / idle_touch）。"""

    kind: str
    payload: dict[str, Any] = Field(default_factory=dict)


class GetConfigData(EventData):
    """拉取当前配置。"""


class SetConfigData(EventData):
    """更新配置（含设置 LLM key 的专用字段）。"""

    patch: dict[str, Any] = Field(default_factory=dict)


class TestLlmData(EventData):
    """设置面板「测试连接」。"""

    base_url: str
    model: str
    key: str | None = None


class LoadHistoryData(EventData):
    """拉取历史消息（气泡回填）。"""

    session_id: str
    limit: int = 20


class BehaviorDoneData(EventData):
    """行为执行完成/被中断回报（Phase 3）。"""

    id: str
    interrupted: bool = False


class EnvUpdateData(EventData):
    """环境上报：屏幕/窗口几何（行为决策依据）。"""

    work_area: dict[str, Any] | None = None
    window_pos: dict[str, Any] | None = None
    window_size: dict[str, Any] | None = None


class AudioChunkData(EventData):
    """Phase 2：音频输入走二进制帧（§3.5），文本帧侧仅占位。"""


# ---------------------------------------------------------------- §3.3 服务端 → 客户端


class HelloAckData(EventData):
    """鉴权结果；ok=false 时伴随 error 后断开。"""

    ok: bool
    session_id: str | None = None
    server_version: str = ""
    protocol_version: int = PROTOCOL_VERSION


class StateData(EventData):
    """宠物状态机（驱动动画节奏与行为互斥）。"""

    state: Literal["idle", "walking", "sleeping", "thinking", "speaking", "dragging"]


class BehaviorData(EventData):
    """行为指令（Phase 3）。"""

    id: str
    name: str
    params: dict[str, Any] = Field(default_factory=dict)


class ReplyStartData(EventData):
    """一轮回复开始。"""

    message_id: str


class TokenData(EventData):
    """流式增量文本。"""

    message_id: str
    text: str


class SentenceData(EventData):
    """分句完成（供 TTS 流水线，Phase 2 推送）。"""

    message_id: str
    index: int
    text: str


class EmotionData(EventData):
    """情绪切换（前端表情/动作映射）。"""

    message_id: str
    emotion: str
    intensity: float = 1.0


class ReplyEndData(EventData):
    """一轮回复结束。"""

    message_id: str
    full_text: str = ""
    interrupted: bool | None = None


class ProactiveData(EventData):
    """主动消息（问候/提醒），无对应用户输入。"""

    message_id: str
    text: str
    emotion: str = "neutral"


class HistoryData(EventData):
    """历史回填。"""

    session_id: str
    messages: list[dict[str, Any]] = Field(default_factory=list)


class ConfigData(EventData):
    """配置快照（key 以掩码返回；字段由 shared/config 决定）。"""

    model_config = ConfigDict(extra="allow")


class ErrorData(EventData):
    """错误；fatal=true 表示连接将关闭。"""

    code: str
    message: str
    fatal: bool | None = None


class PongData(EventData):
    """心跳应答。"""


class AudioData(EventData):
    """Phase 2：TTS 音频走二进制帧（§3.5），文本帧侧仅占位。"""


# ---------------------------------------------------------------- 事件注册表

CLIENT_EVENT_MODELS: dict[str, type[EventData]] = {
    "hello": HelloData,
    "user_message": UserMessageData,
    "ping": PingData,
    "interrupt": InterruptData,
    "pet_event": PetEventData,
    "get_config": GetConfigData,
    "set_config": SetConfigData,
    "test_llm": TestLlmData,
    "load_history": LoadHistoryData,
    "behavior_done": BehaviorDoneData,
    "env_update": EnvUpdateData,
    "audio_chunk": AudioChunkData,
}

SERVER_EVENT_MODELS: dict[str, type[EventData]] = {
    "hello_ack": HelloAckData,
    "state": StateData,
    "behavior": BehaviorData,
    "reply_start": ReplyStartData,
    "token": TokenData,
    "sentence": SentenceData,
    "emotion": EmotionData,
    "audio": AudioData,
    "reply_end": ReplyEndData,
    "proactive": ProactiveData,
    "history": HistoryData,
    "config": ConfigData,
    "error": ErrorData,
    "pong": PongData,
}


# ---------------------------------------------------------------- 解析 / 序列化


@dataclass(frozen=True)
class ClientMessage:
    """解析后的客户端消息：原始信封 + 已通过校验的 data 模型。"""

    envelope: Envelope
    data: EventData


def parse_client_message(raw: str) -> ClientMessage:
    """解析一条客户端文本帧；失败抛 ProtocolError（不给上层看裸异常）。"""
    try:
        obj = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ProtocolError(ErrorCode.BAD_MESSAGE, f"JSON 解析失败：{exc}") from exc
    if not isinstance(obj, dict):
        raise ProtocolError(ErrorCode.BAD_MESSAGE, "消息必须是 JSON 对象")

    try:
        envelope = Envelope.model_validate(obj)
    except ValidationError as exc:
        raise ProtocolError(ErrorCode.BAD_MESSAGE, f"信封字段校验失败：{_brief(exc)}") from exc

    if envelope.v != PROTOCOL_VERSION:
        raise ProtocolError(
            ErrorCode.VERSION_MISMATCH,
            f"信封协议版本不支持：{envelope.v}（服务端 {PROTOCOL_VERSION}）",
            fatal=True,
        )

    model_cls = CLIENT_EVENT_MODELS.get(envelope.type)
    if model_cls is None:
        raise ProtocolError(ErrorCode.UNKNOWN_TYPE, f"未知事件类型：{envelope.type}")

    try:
        data = model_cls.model_validate(envelope.data)
    except ValidationError as exc:
        raise ProtocolError(
            ErrorCode.BAD_MESSAGE, f"{envelope.type} 的 data 校验失败：{_brief(exc)}"
        ) from exc

    return ClientMessage(envelope=envelope, data=data)


def make_envelope(
    msg_type: str,
    data: BaseModel | dict[str, Any] | None = None,
    *,
    reply_to: str | None = None,
    msg_id: str | None = None,
) -> Envelope:
    """构造服务端消息信封。"""
    if isinstance(data, BaseModel):
        payload = data.model_dump()
    else:
        payload = data or {}
    return Envelope(
        v=PROTOCOL_VERSION,
        id=msg_id or f"s_{uuid.uuid4().hex}",
        reply_to=reply_to,
        type=msg_type,
        ts=int(time.time() * 1000),
        data=payload,
    )


def serialize_envelope(envelope: Envelope) -> str:
    """序列化为单行 JSON 文本帧。"""
    return json.dumps(envelope.model_dump(mode="json"), ensure_ascii=False)


def _brief(exc: ValidationError, limit: int = 3) -> str:
    """把 Pydantic 校验错误压缩成一行短摘要。"""
    items = [
        f"{'.'.join(str(part) for part in err['loc']) or '(root)'}: {err['msg']}"
        for err in exc.errors()[:limit]
    ]
    return "; ".join(items)
