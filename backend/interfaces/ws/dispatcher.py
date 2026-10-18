"""消息类型 → 用例的路由注册表（设计文档 §2.3 dispatcher）。

原则：协议内但未实现的事件类型，统一回 ``error{code:"NOT_IMPLEMENTED"}``，
禁止静默丢弃。
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any, Awaitable, Callable, cast

from loguru import logger
from starlette.websockets import WebSocketState

from backend.application.chat_pipeline import ChatPipeline
from backend.application.session import SessionManager
from backend.application.settings_service import ConfigInvalid, SettingsService
from backend.interfaces.ws.auth import verify_token
from backend.interfaces.ws.protocol import (
    PROTOCOL_VERSION,
    BehaviorDoneData,
    ClientMessage,
    EnvUpdateData,
    HelloAckData,
    HelloData,
    LoadHistoryData,
    PetEventData,
    SetConfigData,
    TestLlmData,
    UserMessageData,
)
from backend.modules.files import FileRef
from backend.shared.errors import ErrorCode, ProtocolError

if TYPE_CHECKING:  # 避免与 server 运行时循环 import（类型注解专用）
    from backend.application.reminder_service import ReminderDelivery, ReminderService
    from backend.interfaces.ws.server import ConnectionContext
    from backend.modules.behavior.engine import BehaviorEngine
    from backend.modules.chat.history import HistoryStore

Handler = Callable[["ConnectionContext", ClientMessage], Awaitable[None]]

#: tap_head 的轻量情绪回应（v1 不调 LLM；真正"回话"属 proactive，后续版本）
_TAP_HEAD_EMOTION = "happy"
_TAP_HEAD_INTENSITY = 0.9


class _ConnectionSink:
    """把 ConnectionContext 适配为行为引擎的 BehaviorSink（interfaces 层职责）。

    引擎在 modules 层，不感知 WS 细节；连接存活检测依据 starlette WebSocket 的
    client_state（消息循环收到 disconnect 后即变为 DISCONNECTED）。
    """

    def __init__(self, ctx: ConnectionContext) -> None:
        self._ctx = ctx

    async def send_event(
        self, msg_type: str, data: Any = None, *, reply_to: str | None = None
    ) -> bool:
        if self.is_closed():
            return False
        await self._ctx.send_event(msg_type, data, reply_to=reply_to)
        return True

    def is_closed(self) -> bool:
        ws = getattr(self._ctx, "ws", None)
        state = getattr(ws, "client_state", None)
        # 拿不到状态时保守视为未关闭（真实发送失败由 server 层日志兜底）
        return state is not None and state != WebSocketState.CONNECTED


class _ReminderSink:
    """把 ConnectionContext 适配为提醒服务的下行端口（interfaces 层职责）。

    提醒的下行是"主动消息"：先推 ``proactive``（**气泡一定会出**，与语音开关无关），
    再按 delivery.voice 决定是否合成语音帧。语音失败只降级为无声，不影响提醒送达。
    """

    def __init__(self, ctx: ConnectionContext) -> None:
        self._ctx = ctx

    def is_closed(self) -> bool:
        ws = getattr(self._ctx, "ws", None)
        state = getattr(ws, "client_state", None)
        return state is not None and state != WebSocketState.CONNECTED

    async def deliver(self, delivery: ReminderDelivery) -> bool:
        if self.is_closed():
            return False
        await self._ctx.send_event(
            "proactive",
            {
                "message_id": delivery.message_id,
                "text": delivery.text,
                "emotion": delivery.emotion,
                "kind": "reminder",
                "reminder_id": delivery.reminder_id,
                "due_at": delivery.due_at,
                "late": delivery.late,
            },
        )
        if delivery.voice:
            await self._speak(delivery)
        return True

    async def _speak(self, delivery: ReminderDelivery) -> None:
        """可选语音通道：TTS 未启用/失败都只记日志，气泡已经送达。"""
        voice = getattr(self._ctx, "voice", None)
        if voice is None or not getattr(voice, "available", False):
            return
        try:
            reply = voice.open_reply(self._ctx, delivery.message_id)
            reply.push(0, delivery.spoken_text)
            reply.mark_final(0)
            await reply.finish()
        except Exception:
            logger.exception("提醒语音播报失败（气泡不受影响）")


class Dispatcher:
    """事件路由表：按信封 type 分发到 handler。"""

    def __init__(self) -> None:
        self._handlers: dict[str, Handler] = {}

    def register(self, msg_type: str, handler: Handler) -> None:
        if msg_type in self._handlers:
            raise ValueError(f"事件类型重复注册：{msg_type}")
        self._handlers[msg_type] = handler

    def has(self, msg_type: str) -> bool:
        """是否已注册该类型的 handler。"""
        return msg_type in self._handlers

    async def dispatch(self, ctx: ConnectionContext, msg: ClientMessage) -> None:
        """分发一条消息；未注册类型回 NOT_IMPLEMENTED。"""
        handler = self._handlers.get(msg.envelope.type)
        if handler is None:
            await ctx.send_error(
                ErrorCode.NOT_IMPLEMENTED,
                f"事件类型 {msg.envelope.type} 尚未实现",
                reply_to=msg.envelope.id,
            )
            return
        try:
            await handler(ctx, msg)
        except ProtocolError as exc:
            await ctx.send_error(
                exc.code, exc.message, fatal=exc.fatal, reply_to=msg.envelope.id
            )
            if exc.fatal:
                ctx.request_close(1002, "protocol error")
        except Exception:
            logger.exception("处理事件 {} 时发生未预期异常", msg.envelope.type)
            await ctx.send_error(
                ErrorCode.INTERNAL, "服务端内部错误", reply_to=msg.envelope.id
            )


def build_dispatcher(
    *,
    pipeline: ChatPipeline,
    sessions: SessionManager,
    token: str,
    app_version: str,
    engine: BehaviorEngine | None = None,
    history: HistoryStore | None = None,
    settings: SettingsService | None = None,
    reminders: ReminderService | None = None,
) -> Dispatcher:
    """装配默认事件路由（interfaces → application 的唯一接线点）。

    ``engine``：自主行为引擎（Phase 3，可为 None——未装配时 pet_event /
    behavior_done / env_update 走惰性兜底分支，不阻断其余事件）。
    ``history``：会话历史库（P3，可为 None——load_history 退化为空历史回填）。
    ``settings``：设置面板用例（§7.6，可为 None——未装配时 get_config /
    set_config / test_llm 走 NOT_IMPLEMENTED 兜底，与旧版行为一致）。
    ``reminders``：提醒调度服务（2026-10-18，可为 None——未装配存储时无提醒功能）。
    """
    dispatcher = Dispatcher()

    async def on_ping(ctx: ConnectionContext, msg: ClientMessage) -> None:
        """心跳（§3.6）：回 pong。"""
        await ctx.send_event("pong", {}, reply_to=msg.envelope.id)

    async def on_hello(ctx: ConnectionContext, msg: ClientMessage) -> None:
        """鉴权 + 版本协商（§3.4）：失败回 hello_ack(ok=false) + error(fatal) 后断开。"""
        data = cast(HelloData, msg.data)
        ack_failure = HelloAckData(
            ok=False, server_version=app_version, protocol_version=PROTOCOL_VERSION
        )

        if data.protocol_version != PROTOCOL_VERSION:
            await ctx.send_event("hello_ack", ack_failure, reply_to=msg.envelope.id)
            await ctx.send_error(
                ErrorCode.VERSION_MISMATCH,
                f"协议版本不匹配：客户端 {data.protocol_version}，服务端 {PROTOCOL_VERSION}",
                fatal=True,
                reply_to=msg.envelope.id,
            )
            ctx.request_close(1008, "protocol version mismatch")
            return

        if not verify_token(data.token, token):
            await ctx.send_event("hello_ack", ack_failure, reply_to=msg.envelope.id)
            await ctx.send_error(
                ErrorCode.AUTH_FAILED, "token 校验失败", fatal=True, reply_to=msg.envelope.id
            )
            ctx.request_close(1008, "auth failed")
            return

        session = sessions.start(ctx.session_id)
        ctx.session_id = session.id
        ctx.authed = True
        await ctx.send_event(
            "hello_ack",
            HelloAckData(
                ok=True,
                session_id=session.id,
                server_version=app_version,
                protocol_version=PROTOCOL_VERSION,
            ),
            reply_to=msg.envelope.id,
        )
        logger.info(
            "连接 {} 鉴权通过，session={} role={}", ctx.id, session.id, data.client_role
        )
        # 主动推送通道只绑宠物窗（client_role）：设置窗自建连接只收发配置，
        # 不抢行为/提醒的事件推送（2026-10-18；旧客户端缺省按 pet 兼容）
        if data.client_role == "pet":
            if engine is not None:
                # 行为引擎绑定当前连接（全局单例向"当前连接"推送；断开由引擎自检清理）
                engine.set_connection(_ConnectionSink(ctx))
            if reminders is not None:
                reminders.set_connection(_ReminderSink(ctx))
        else:
            logger.info("连接 {} 为设置窗：不绑定行为/提醒推送通道", ctx.id)

    async def on_user_message(ctx: ConnectionContext, msg: ClientMessage) -> None:
        """用户消息：以后台任务运行对话流水线，消息循环保持可用（可即时处理 interrupt）。"""
        data = cast(UserMessageData, msg.data)
        text = data.text.strip()
        attachments = [
            FileRef(path=a.path, name=a.name) for a in data.attachments
        ]
        # 纯附件（选了文件没打字）是合法输入；文字和附件都为空才报错。
        if not text and not attachments:
            await ctx.send_error(
                ErrorCode.BAD_MESSAGE, "user_message.text 不能为空", reply_to=msg.envelope.id
            )
            return
        if engine is not None:
            engine.note_conversation()  # 被聊 → mood ↑（软状态）
        session = sessions.start(data.session_id or ctx.session_id)
        ctx.session_id = session.id
        await ctx.spawn_reply(
            pipeline.run_turn(
                ctx,
                session=session,
                user_text=text,
                voice=ctx.voice,
                attachments=attachments,
            )
        )

    async def on_interrupt(ctx: ConnectionContext, msg: ClientMessage) -> None:
        """打断（§7.2）：取消当前回复任务。

        LLM 流与 TTS 合成同属该任务的取消链——流水线收到取消后先清空 TTS
        队列、停止推帧（已合成的帧不再推），再推 reply_end{interrupted} 与
        state:idle。因此本处只需取消回复任务本身。
        """
        await ctx.cancel_reply()

    async def on_load_history(ctx: ConnectionContext, msg: ClientMessage) -> None:
        """拉取历史消息（§3.2 load_history → §3.3 history）：气泡回填。

        - ``session_id`` 缺省用当前连接会话；库里没有该会话（或未装配历史库）
          时返回空列表——回填是软功能，不因此报错；
        - 返回最近 ``limit`` 条（时间正序），字段见 HistoryStore.recent_messages。
        """
        data = cast(LoadHistoryData, msg.data)
        session_id = (data.session_id or ctx.session_id or "").strip()
        messages = (
            history.recent_messages(session_id, limit=data.limit)
            if history is not None and session_id
            else []
        )
        await ctx.send_event(
            "history",
            {"session_id": session_id, "messages": messages},
            reply_to=msg.envelope.id,
        )
        logger.info("历史回填 session={} 条数={}", session_id or "(无)", len(messages))

    async def on_pet_event(ctx: ConnectionContext, msg: ClientMessage) -> None:
        """宠物交互事件（§3.2）：tap_head → mood ↑ + 轻量情绪回应（v1 不调 LLM）。"""
        data = cast(PetEventData, msg.data)
        mood = engine.note_pet_event(data.kind) if engine is not None else None
        if data.kind == "tap_head":
            await ctx.send_event(
                "emotion",
                {
                    "message_id": "",
                    "emotion": _TAP_HEAD_EMOTION,
                    "intensity": _TAP_HEAD_INTENSITY,
                },
            )
            logger.info("tap_head：已推 emotion({})，mood={}", _TAP_HEAD_EMOTION, mood)
        else:
            # drag_end / idle_touch：v1 只记录（行为引擎不依赖，前端暂不上报）
            logger.debug("pet_event kind={} payload={}（v1 无回应）", data.kind, data.payload)

    async def on_behavior_done(ctx: ConnectionContext, msg: ClientMessage) -> None:
        """行为执行完成/被中断回报（§7.4）：唤醒引擎中等待中的本轮行为。"""
        data = cast(BehaviorDoneData, msg.data)
        if engine is not None:
            engine.on_behavior_done(data.id, data.interrupted)
        else:
            logger.debug("behavior_done id={}（未装配行为引擎，忽略）", data.id)

    async def on_env_update(ctx: ConnectionContext, msg: ClientMessage) -> None:
        """环境上报（§4.5.5）：更新引擎的环境快照（几何/系统空闲/宠物状态）。"""
        data = cast(EnvUpdateData, msg.data)
        if engine is not None:
            engine.update_env(data)

    # ---------- 设置面板（§7.6；未装配 settings 时不注册，走 NOT_IMPLEMENTED） ----------

    async def on_get_config(ctx: ConnectionContext, msg: ClientMessage) -> None:
        """拉取配置快照（§3.2 get_config → §3.3 config）：key 以掩码返回，绝不回明文。"""
        assert settings is not None  # 仅在装配了 settings 时注册（见下方注册块）
        await ctx.send_event("config", settings.snapshot(), reply_to=msg.envelope.id)

    async def on_set_config(ctx: ConnectionContext, msg: ClientMessage) -> None:
        """更新配置（§7.6.3）：校验 → key 入 keyring + 写回 toml → 热重装配 → config 回执。

        - 字段校验失败：error{code:"CONFIG_INVALID", message:具体原因}，不改任何状态；
        - 成功：推 `config`（新快照）作回执，reply_to 配对请求。
        """
        assert settings is not None
        data = cast(SetConfigData, msg.data)
        try:
            snapshot = await settings.apply_patch(data.patch)
        except ConfigInvalid as exc:
            await ctx.send_error(
                ErrorCode.CONFIG_INVALID, exc.message, reply_to=msg.envelope.id
            )
            return
        await ctx.send_event("config", snapshot, reply_to=msg.envelope.id)

    async def on_test_llm(ctx: ConnectionContext, msg: ClientMessage) -> None:
        """测试连接（§3.2 test_llm → §3.3 llm_test_result）：

        最小 chat 请求验证鉴权与地址 + 尽力拉 /models；失败 message 说明具体原因。
        """
        assert settings is not None
        data = cast(TestLlmData, msg.data)
        payload = await settings.test_llm(
            base_url=data.base_url, model=data.model, key=data.key
        )
        await ctx.send_event("llm_test_result", payload, reply_to=msg.envelope.id)

    dispatcher.register("ping", on_ping)
    dispatcher.register("hello", on_hello)
    dispatcher.register("user_message", on_user_message)
    dispatcher.register("interrupt", on_interrupt)
    dispatcher.register("load_history", on_load_history)
    dispatcher.register("pet_event", on_pet_event)
    dispatcher.register("behavior_done", on_behavior_done)
    dispatcher.register("env_update", on_env_update)
    if settings is not None:
        dispatcher.register("get_config", on_get_config)
        dispatcher.register("set_config", on_set_config)
        dispatcher.register("test_llm", on_test_llm)
    return dispatcher
