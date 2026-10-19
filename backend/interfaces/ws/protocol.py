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
    """连接后首条消息：鉴权 + 版本协商。

    ``client_role``（2026-10-18）：连接角色——``pet``（宠物窗，行为/提醒推送的
    接收方）/ ``settings``（设置窗，只收发配置）。缺省 ``pet`` 兼容旧客户端；
    多连接时路由按角色判定，避免设置窗抢走主动推送通道。
    """

    token: str
    protocol_version: int
    app_version: str = ""
    client_role: Literal["pet", "settings"] = "pet"


class AttachmentRefData(EventData):
    """附件引用（文件分析 P1）：用户在本机显式选择的文件。

    只传路径与显示名，**不传文件正文**——正文由本机后端读取，避免大文件走 WS。
    路径只在后端本地使用，不进入提示词、不写日志；模型只看到文件名。
    """

    path: str
    name: str = ""


class UserMessageOptions(EventData):
    """单轮对话选项（工作模式，2026-10-18）。

    - ``think``：本轮追加"先充分推理"提示并抬高输出预算（同一模型，不切换）；
    - ``search``：本轮是否提供联网工具（False 时移除 web_search / web_fetch，
      其余工具不受影响）。
    旧客户端不传 = None，行为与之前完全一致（允许搜索、不切模型）。
    """

    think: bool = False
    search: bool = True


class UserMessageData(EventData):
    """用户文字输入；可携带本轮附件（文件分析 P1）与单轮选项（工作模式）。

    ``client_id``：前端本地消息 id（工作窗用它把落库后的 DB id 挂回同一条消息，
    删除时按 DB id 精确删）；旧客户端不传不影响对话。
    """

    text: str
    session_id: str | None = None
    attachments: list[AttachmentRefData] = Field(default_factory=list)
    options: UserMessageOptions | None = None
    client_id: str | None = None


class DeleteMessageData(EventData):
    """删除单条消息（工作模式，2026-10-18）：按 messages 表行 id 删当前会话的一条。"""

    id: int


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
    """设置面板「测试连接」。

    §3.2 声明 ``{base_url, model, key?}``；服务端对 base_url / model 宽容缺省
    （用当前配置），key 缺省用读取链（keyring 为主）——设置面板"先测再存"
    与"用已存配置测"两种用法都成立。
    """

    base_url: str | None = None
    model: str | None = None
    key: str | None = None


class LoadHistoryData(EventData):
    """拉取历史消息（气泡回填；P3 实现）。

    - ``session_id`` 缺省：回填**当前连接会话**（hello 建立/续用的会话）；
    - ``limit``：返回最近 N 条（服务端再按 MAX_HISTORY_LIMIT 夹取）。
    """

    session_id: str | None = None
    limit: int = 20


class BehaviorDoneData(EventData):
    """行为执行完成/被中断回报（Phase 3）。"""

    id: str
    interrupted: bool = False


class GetRemindersData(EventData):
    """拉取未读提醒（提醒列表；2026-10-18）。"""

    limit: int = 50


class AckRemindersData(EventData):
    """提醒已读回执：按事件 id 或全部标记已读（2026-10-18）。"""

    ids: list[str] = Field(default_factory=list)
    all: bool = False


class GetReminderHistoryData(EventData):
    """拉取时钟视图（当天事件 + 所有未到期计划；缺省今天）。"""

    date: str | None = None
    limit: int = 200


class DeleteReminderItemData(EventData):
    """删除时钟视图里的一项（id 为 reminder_events.id 或 reminders.id）。"""

    id: str


# ---------------------------------------------------------------- §3.2 记忆本（2026-10-18）


class MemoryBookListData(EventData):
    """设置页：拉取记忆本条目。"""

    kind: str | None = None


class MemoryBookItemInput(EventData):
    """设置页新增/更新一条记忆本条目（与工具 save_item 的 item 同构）。"""

    name: str = ""
    kind: str | None = None
    value: str


class MemoryBookSaveData(EventData):
    """设置页保存（同名更新）。"""

    items: list[MemoryBookItemInput] = Field(default_factory=list)


class MemoryBookRenameData(EventData):
    """设置页改名。"""

    old_name: str
    new_name: str


class MemoryBookDeleteData(EventData):
    """设置页删除**记录**（不动磁盘文件；设置页按钮即明确操作）。"""

    names: list[str] = Field(default_factory=list)


class MemoryBookFileDeletedData(EventData):
    """宠物面：主进程已确认删除真实文件（移入回收站）——后端据此移除记录/清记忆。"""

    path: str


class EnvUpdateData(EventData):
    """环境上报：屏幕/窗口几何 + 系统空闲 + 宠物状态（行为决策依据）。"""

    work_area: dict[str, Any] | None = None
    window_pos: dict[str, Any] | None = None
    window_size: dict[str, Any] | None = None
    #: 系统空闲秒数（Electron powerMonitor.getSystemIdleTime）——"用户是否在用电脑"
    system_idle_seconds: float | None = None
    #: 渲染侧当前宠物状态（idle/walking/sleeping/thinking/speaking/dragging）——
    #: 对话中引擎静默的依据（引擎不读 chat_pipeline，对话状态经此旁路上报）
    pet_state: str | None = None


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


class MessageSavedData(EventData):
    """一条消息已落库（工作模式，2026-10-18）：把 DB 行 id 回给前端。

    - 用户消息：``client_id`` 是前端本地消息 id（user_message.client_id 原样回传）；
    - 助手消息：``client_id`` 是 reply 的 ``message_id``。
    """

    client_id: str = ""
    db_id: int
    role: str


class MessageDeletedData(EventData):
    """单条消息删除结果（工作模式）；ok=false 表示 id 不属于当前会话/已不存在。"""

    id: int
    ok: bool = True


class ReasoningData(EventData):
    """推理模型（如 deepseek-reasoner）的思考过程增量。

    在工作模式窗口折叠展示（「已思考」）；教学黑板/宠物气泡不消费。
    只有网关返回 ``delta.reasoning_content`` 时才有该事件。
    """

    message_id: str
    text: str


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


class ToolCallData(EventData):
    """工具调用（服务端 → 客户端执行，§4.7 工具机制）。

    模型本轮请求调用的内置工具（如 ``open_settings`` → 前端打开设置窗）。
    在对应回复的 ``reply_end`` 之后推送；``id`` 为本次调用的唯一标识
    （将来"结果回传续写"按 id 配对，当前前端仅按 ``name`` 执行、无需回执）。
    """

    id: str
    name: str
    args: dict[str, Any] = Field(default_factory=dict)


class ReminderItemData(EventData):
    """提醒批次里的单项（proactive.items / reminders.items / history.items 共用）。

    已触发事件：``id`` 是 reminder_events 事件 id——前端"知道了"按它回执；
    未到期计划（2026-10-18 时钟入口视图）：``pending=True``，``id`` 是 reminders.id，
    ``fired_at`` 为空、不可回执已读。``time_text`` 是后端格式化好的用户可读时间。
    """

    id: str
    reminder_id: str = ""
    text: str = ""
    due_at: str = ""
    fired_at: str = ""
    late: bool = False
    acknowledged: bool = False
    pending: bool = False
    time_text: str = ""


class ProactiveData(EventData):
    """主动消息（问候/提醒），无对应用户输入。

    提醒（2026-10-18）：同一轮到期的多条合并为一批（``items``），``text`` 是给气泡的
    完整列表文案；前端**无论语音开关如何都展示气泡**，语音只是附加的音频帧。
    """

    message_id: str
    text: str
    emotion: str = "neutral"
    kind: Literal["greeting", "reminder"] = "greeting"
    batch_id: str | None = None
    items: list[ReminderItemData] = Field(default_factory=list)
    # 兼容单条旧字段：items 的第一项（新前端优先读 items）
    reminder_id: str | None = None
    due_at: str | None = None
    late: bool = False


class RemindersData(EventData):
    """未读提醒快照（get_reminders / ack_reminders 的响应）。

    ``pending`` 是尚未到期的计划（灰灯，不进入未读列表；底部灰灯展开用），
    ``pending_count`` 与其等长。
    """

    items: list[ReminderItemData] = Field(default_factory=list)
    unread_count: int = 0
    pending: list[ReminderItemData] = Field(default_factory=list)
    pending_count: int = 0


class ReminderHistoryData(EventData):
    """时钟入口视图快照：当天事件（已读 + 未读）+ 所有未到期计划，按到期时间正序。

    ``items`` 里未到期项 ``pending=True``；``read_count/unread_count`` 只统计事件，
    ``pending_count`` 单独统计未到期计划（2026-10-18）。
    """

    date: str
    items: list[ReminderItemData] = Field(default_factory=list)
    read_count: int = 0
    unread_count: int = 0
    pending_count: int = 0


class MemoryBookItemData(EventData):
    """记忆本条目快照（设置页列表）。``path_exists`` 只对 path 类有意义。"""

    id: int
    name: str
    kind: str
    value: str
    is_dir: bool = False
    created_at: int = 0
    updated_at: int = 0
    path_exists: bool = True


class MemoryBookItemsData(EventData):
    """记忆本列表响应（memory_book_list / 保存成功后的刷新）。"""

    items: list[MemoryBookItemData] = Field(default_factory=list)
    count: int = 0


class MemoryBookResultData(EventData):
    """记忆本写操作结果（保存/改名/删除/文件已删）。"""

    ok: bool
    code: str = ""
    message: str = ""


class NoticeData(EventData):
    """一次性提示（不进入对话历史、不参与 TTS）。

    文件分析 P1：``context_reset`` —— 为装下当前文件，本轮已丢弃之前的上下文
    （数据库/界面历史仍在）。前端以聊天面板上方的轻提示展示。
    """

    code: str
    message: str
    level: Literal["info", "warn", "error"] = "info"


class SourceItemData(EventData):
    """联网搜索的一条来源（工作窗引用悬浮卡片用，2026-10-18）。

    与正文分离：正文只有 ``[n]`` 角标，标题/摘要/站点/日期由后端从搜索结果
    结构化带回，前端按 URL 匹配后展示悬浮卡片。
    """

    index: int = 0
    title: str = ""
    url: str
    snippet: str = ""
    site_name: str = ""
    date: str = ""


class SourcesData(EventData):
    """一轮回复用到的搜索来源（不进入正文/TTS）。"""

    message_id: str
    items: list[SourceItemData] = Field(default_factory=list)


class HistoryData(EventData):
    """历史回填。"""

    session_id: str
    messages: list[dict[str, Any]] = Field(default_factory=list)


class ConfigData(EventData):
    """配置快照（key 以掩码返回；字段由 shared/config 决定）。"""

    model_config = ConfigDict(extra="allow")


class GetProfileData(EventData):
    """拉取用户画像摘要（2026-10-18 启动称呼引导）：无字段。"""


class NoteAssistantMessageData(EventData):
    """前端本地展示的助手台词补录（2026-10-18 启动称呼提问）。

    气泡里的问候/提问由主进程本地展示、不经过 LLM；补录进会话历史后，
    用户对提问的回答才有上下文（LLM 理解 + 后台记忆提取写入画像）。
    只记历史，**不触发回复、不产生 TTS**。
    """

    text: str = Field(min_length=1, max_length=500)


class ProfileData(EventData):
    """用户画像摘要：只暴露称呼类信息（是否有名字 + 名字本身）。

    ``memory_enabled``：后台记忆提取开关——关闭时名字不会被自动写入画像，
    前端据此跳过称呼引导（避免"问了却永远存不上"）。
    """

    has_name: bool
    name: str | None = None
    memory_enabled: bool = True


class LlmTestResultData(EventData):
    """「测试连接」结果（§3.3）：失败时 message 说明具体原因（连不上 / 401 / 404…）；
    成功且网关支持 ``/models`` 时附可用模型列表（供下拉），拉不到则省略该字段。"""

    ok: bool
    message: str = ""
    models: list[str] | None = None


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
    "get_profile": GetProfileData,
    "note_assistant_message": NoteAssistantMessageData,
    "load_history": LoadHistoryData,
    "delete_message": DeleteMessageData,
    "behavior_done": BehaviorDoneData,
    "env_update": EnvUpdateData,
    "get_reminders": GetRemindersData,
    "ack_reminders": AckRemindersData,
    "get_reminder_history": GetReminderHistoryData,
    "delete_reminder_item": DeleteReminderItemData,
    "memory_book_list": MemoryBookListData,
    "memory_book_save": MemoryBookSaveData,
    "memory_book_rename": MemoryBookRenameData,
    "memory_book_delete": MemoryBookDeleteData,
    "memory_book_file_deleted": MemoryBookFileDeletedData,
    "audio_chunk": AudioChunkData,
}

SERVER_EVENT_MODELS: dict[str, type[EventData]] = {
    "hello_ack": HelloAckData,
    "state": StateData,
    "behavior": BehaviorData,
    "reply_start": ReplyStartData,
    "message_saved": MessageSavedData,
    "message_deleted": MessageDeletedData,
    "reasoning": ReasoningData,
    "token": TokenData,
    "sentence": SentenceData,
    "emotion": EmotionData,
    "audio": AudioData,
    "reply_end": ReplyEndData,
    "tool_call": ToolCallData,
    "proactive": ProactiveData,
    "reminders": RemindersData,
    "reminder_history": ReminderHistoryData,
    "memory_book_items": MemoryBookItemsData,
    "memory_book_result": MemoryBookResultData,
    "notice": NoticeData,
    "sources": SourcesData,
    "history": HistoryData,
    "config": ConfigData,
    "profile": ProfileData,
    "llm_test_result": LlmTestResultData,
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


# ---------------------------------------------------------------- 二进制帧（§3.5，v1 冻结）


#: 音频帧类型（JSON 头 type 字段取值）
AUDIO_FRAME_TYPE = "audio"
#: 音频格式与采样率（Edge TTS 默认输出 24kHz 单声道 mp3，与 §3.5 示例一致）
AUDIO_FORMAT = "mp3"
AUDIO_SAMPLE_RATE = 24000


def make_audio_header(message_id: str, seq: int, *, final: bool) -> dict[str, Any]:
    """构造 §3.5 音频帧 JSON 头（字段顺序固定，便于前端/测试比对）。"""
    return {
        "type": AUDIO_FRAME_TYPE,
        "message_id": message_id,
        "seq": seq,
        "format": AUDIO_FORMAT,
        "sample_rate": AUDIO_SAMPLE_RATE,
        "final": final,
    }


def pack_audio_frame(json_header: dict[str, Any], payload: bytes) -> bytes:
    """打包二进制音频帧：``[4字节大端 JSON 头长度 N][JSON头 N字节][音频数据]``（§3.5）。

    音频不走 base64——直接二进制帧（对比 base64 内嵌 JSON 体积膨胀 33%）。
    """
    head = json.dumps(json_header, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    if len(head) > 0xFFFFFFFF:
        raise ValueError(f"音频帧头过大：{len(head)} 字节")
    return len(head).to_bytes(4, "big") + head + payload


def unpack_audio_frame(frame: bytes) -> tuple[dict[str, Any], bytes]:
    """解析二进制音频帧，返回 ``(JSON头, 音频数据)``；格式非法抛 ValueError。

    供测试与冒烟脚本校验使用（后端下行路径只打包不解析）。
    """
    if len(frame) < 4:
        raise ValueError(f"音频帧过短：{len(frame)} 字节（不足 4 字节头长字段）")
    head_len = int.from_bytes(frame[:4], "big")
    if len(frame) < 4 + head_len:
        raise ValueError(f"音频帧头长越界：声明 {head_len} 字节，实际仅 {len(frame) - 4} 字节")
    try:
        header = json.loads(frame[4 : 4 + head_len].decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ValueError(f"音频帧 JSON 头不可解析：{exc}") from exc
    if not isinstance(header, dict):
        raise ValueError("音频帧 JSON 头必须是对象")
    return header, frame[4 + head_len :]


def _brief(exc: ValidationError, limit: int = 3) -> str:
    """把 Pydantic 校验错误压缩成一行短摘要。"""
    items = [
        f"{'.'.join(str(part) for part in err['loc']) or '(root)'}: {err['msg']}"
        for err in exc.errors()[:limit]
    ]
    return "; ".join(items)
