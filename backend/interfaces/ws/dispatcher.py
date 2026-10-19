"""消息类型 → 用例的路由注册表（设计文档 §2.3 dispatcher）。

原则：协议内但未实现的事件类型，统一回 ``error{code:"NOT_IMPLEMENTED"}``，
禁止静默丢弃。
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any, Awaitable, Callable, cast

from loguru import logger
from starlette.websockets import WebSocketState

from backend.application.chat_pipeline import ChatPipeline, TurnOptions
from backend.application.session import SessionManager
from backend.application.settings_service import ConfigInvalid, SettingsService
from backend.interfaces.ws.auth import verify_token
from backend.interfaces.ws.protocol import (
    PROTOCOL_VERSION,
    AckRemindersData,
    BehaviorDoneData,
    ClientMessage,
    DeleteMessageData,
    DeleteReminderItemData,
    EnvUpdateData,
    GetReminderHistoryData,
    GetRemindersData,
    HelloAckData,
    HelloData,
    LoadHistoryData,
    MemoryBookDeleteData,
    MemoryBookFileDeletedData,
    MemoryBookListData,
    MemoryBookRenameData,
    MemoryBookSaveData,
    NoteAssistantMessageData,
    PetEventData,
    SetConfigData,
    TestLlmData,
    UserMessageData,
)
from backend.modules.files import FileRef
from backend.modules.memory_book import KINDS
from backend.shared.errors import ErrorCode, ProtocolError

if TYPE_CHECKING:  # 避免与 server 运行时循环 import（类型注解专用）
    from backend.application.memory_book_service import MemoryBookService
    from backend.application.reminder_service import ReminderDelivery, ReminderService
    from backend.interfaces.ws.server import ConnectionContext
    from backend.modules.behavior.engine import BehaviorEngine
    from backend.modules.chat.history import HistoryStore
    from backend.modules.memory.profile import ProfileStore

Handler = Callable[["ConnectionContext", ClientMessage], Awaitable[None]]

#: tap_head 的轻量情绪回应（v1 不调 LLM；真正"回话"属 proactive，后续版本）
_TAP_HEAD_EMOTION = "happy"
_TAP_HEAD_INTENSITY = 0.9

#: 画像里可能存放"用户称呼"的 key（记忆提取 prompt 建议 称呼/姓名；昵称/用户名兜底）
_USER_NAME_PROFILE_KEYS = ("称呼", "姓名", "昵称", "用户名")


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
        first = delivery.items[0] if delivery.items else None
        await self._ctx.send_event(
            "proactive",
            {
                "message_id": delivery.message_id,
                "text": delivery.text,
                "emotion": delivery.emotion,
                "kind": "reminder",
                "batch_id": delivery.batch_id,
                "items": [
                    {
                        "id": item.event_id,
                        "reminder_id": item.reminder_id,
                        "text": item.text,
                        "due_at": item.due_at,
                        "late": item.late,
                    }
                    for item in delivery.items
                ],
                # 兼容旧字段：批次第一项
                "reminder_id": first.reminder_id if first else None,
                "due_at": first.due_at if first else None,
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
    memory_book: MemoryBookService | None = None,
    profile: ProfileStore | None = None,
    memory_enabled: Callable[[], bool] | None = None,
) -> Dispatcher:
    """装配默认事件路由（interfaces → application 的唯一接线点）。

    ``engine``：自主行为引擎（Phase 3，可为 None——未装配时 pet_event /
    behavior_done / env_update 走惰性兜底分支，不阻断其余事件）。
    ``history``：会话历史库（P3，可为 None——load_history 退化为空历史回填）。
    ``settings``：设置面板用例（§7.6，可为 None——未装配时 get_config /
    set_config / test_llm 走 NOT_IMPLEMENTED 兜底，与旧版行为一致）。
    ``reminders``：提醒调度服务（2026-10-18，可为 None——未装配存储时无提醒功能）。
    ``memory_book``：记忆本服务（2026-10-18，可为 None——未装配时设置页记忆本请求
    与 ``memory_book_file_deleted`` 均走 NOT_IMPLEMENTED；工具也不会注册）。
    ``profile``：用户画像存储（2026-10-18 启动称呼引导，可为 None——未装配时
    get_profile 走 NOT_IMPLEMENTED；前端静默跳过称呼引导）。
    ``memory_enabled``：后台记忆提取开关的活引用（get_profile 回给前端，用于判断
    "问了名字也存不上"时是否跳过引导）。
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
        ctx.client_role = data.client_role
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
                options=(
                    TurnOptions(
                        think=data.options.think, search=data.options.search
                    )
                    if data.options is not None
                    else None
                ),
                client_id=data.client_id,
            )
        )

    async def on_interrupt(ctx: ConnectionContext, msg: ClientMessage) -> None:
        """打断（§7.2）：取消当前回复任务。

        LLM 流与 TTS 合成同属该任务的取消链——流水线收到取消后先清空 TTS
        队列、停止推帧（已合成的帧不再推），再推 reply_end{interrupted} 与
        state:idle。因此本处只需取消回复任务本身。
        """
        await ctx.cancel_reply()

    async def on_delete_message(ctx: ConnectionContext, msg: ClientMessage) -> None:
        """删除当前会话的单条消息（工作模式，2026-10-18）。

        - 只按 ``ctx.session_id + id`` 删，跨会话/不存在的 id 一律 ok=false；
        - 删除后重建会话内存上下文，保证模型下一轮不再看到该消息；
        - 不联动删除“配对”的另一条（用户定稿：删单条，不删整轮）。
        """
        data = cast(DeleteMessageData, msg.data)
        session = sessions.get(ctx.session_id or "")
        if session is None or history is None:
            await ctx.send_event("message_deleted", {"id": data.id, "ok": False})
            return
        ok = history.delete_message(session.id, data.id)
        if ok:
            session.reload_history()
        await ctx.send_event("message_deleted", {"id": data.id, "ok": ok})
        logger.info("删除消息 session={} id={} ok={}", session.id, data.id, ok)

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

    # ---------- 提醒列表（2026-10-18；未装配提醒服务时不注册） ----------

    async def on_get_reminders(ctx: ConnectionContext, msg: ClientMessage) -> None:
        """拉取未读提醒快照（列表/未读数）。"""
        assert reminders is not None
        data = cast(GetRemindersData, msg.data)
        await ctx.send_event(
            "reminders", reminders.list_unread(limit=data.limit), reply_to=msg.envelope.id
        )

    async def on_ack_reminders(ctx: ConnectionContext, msg: ClientMessage) -> None:
        """标记提醒已读（按事件 id 或全部），回更新后的未读快照。"""
        assert reminders is not None
        data = cast(AckRemindersData, msg.data)
        await ctx.send_event(
            "reminders",
            reminders.acknowledge(data.ids, all_=data.all),
            reply_to=msg.envelope.id,
        )

    async def on_get_reminder_history(ctx: ConnectionContext, msg: ClientMessage) -> None:
        """拉取时钟视图：当天事件（已读 + 未读）+ 所有未到期计划，按到期时间正序。"""
        assert reminders is not None
        data = cast(GetReminderHistoryData, msg.data)
        await ctx.send_event(
            "reminder_history",
            reminders.list_history(data.date, limit=data.limit),
            reply_to=msg.envelope.id,
        )

    async def on_delete_reminder_item(ctx: ConnectionContext, msg: ClientMessage) -> None:
        """删除时钟视图里的一项（已触发事件或未到期计划），回两份刷新快照。"""
        assert reminders is not None
        data = cast(DeleteReminderItemData, msg.data)
        result = reminders.delete_item(data.id)
        if not result.get("ok"):
            logger.info("删除提醒项未命中：id={}", data.id)
        # 事件删除影响未读/历史；计划删除影响 pending；两份快照都回，前端自然收敛
        await ctx.send_event(
            "reminders",
            reminders.list_unread(limit=100),
            reply_to=msg.envelope.id,
        )
        await ctx.send_event(
            "reminder_history",
            reminders.list_history(None),
            reply_to=msg.envelope.id,
        )

    # ---------- 记忆本（2026-10-18；未装配 memory_book 时不注册） ----------

    async def on_memory_book_list(ctx: ConnectionContext, msg: ClientMessage) -> None:
        """设置页：拉取记忆本快照（可按类型过滤）。"""
        assert memory_book is not None
        data = cast(MemoryBookListData, msg.data)
        kind = data.kind if data.kind in KINDS else None
        await ctx.send_event(
            "memory_book_items", memory_book.snapshot(kind), reply_to=msg.envelope.id
        )

    async def on_memory_book_save(ctx: ConnectionContext, msg: ClientMessage) -> None:
        """设置页：保存/同名更新，回结果 + 最新快照。"""
        assert memory_book is not None
        data = cast(MemoryBookSaveData, msg.data)
        result = memory_book.save_from_tool(
            [item.model_dump() for item in data.items],
            allow_program=ctx.client_role == "settings",
        )
        await ctx.send_event("memory_book_result", result, reply_to=msg.envelope.id)
        if result.get("ok"):
            await ctx.send_event(
                "memory_book_items", memory_book.snapshot(), reply_to=msg.envelope.id
            )

    async def on_memory_book_rename(ctx: ConnectionContext, msg: ClientMessage) -> None:
        """设置页：改名；成功回最新快照。"""
        assert memory_book is not None
        data = cast(MemoryBookRenameData, msg.data)
        result = memory_book.rename_from_tool(data.old_name, data.new_name)
        await ctx.send_event("memory_book_result", result, reply_to=msg.envelope.id)
        if result.get("ok"):
            await ctx.send_event(
                "memory_book_items", memory_book.snapshot(), reply_to=msg.envelope.id
            )

    async def on_memory_book_delete(ctx: ConnectionContext, msg: ClientMessage) -> None:
        """设置页：删除记录（按钮即明确操作，trust=True 跳过"点名"保护）。"""
        assert memory_book is not None
        data = cast(MemoryBookDeleteData, msg.data)
        result = memory_book.delete_from_tool(data.names, trust=True)
        await ctx.send_event("memory_book_result", result, reply_to=msg.envelope.id)
        if result.get("ok"):
            await ctx.send_event(
                "memory_book_items", memory_book.snapshot(), reply_to=msg.envelope.id
            )

    async def on_memory_book_file_deleted(
        ctx: ConnectionContext, msg: ClientMessage
    ) -> None:
        """宠物面：主进程已确认删除真实文件——移除记忆本记录并清理长期记忆。"""
        assert memory_book is not None
        data = cast(MemoryBookFileDeletedData, msg.data)
        result = memory_book.forget_by_path(data.path)
        await ctx.send_event("memory_book_result", result, reply_to=msg.envelope.id)
        if result.get("ok"):
            await ctx.send_event(
                "memory_book_items", memory_book.snapshot(), reply_to=msg.envelope.id
            )

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

    # ---------- 用户画像（2026-10-18 启动称呼引导；未装配 profile 时不注册） ----------

    async def on_get_profile(ctx: ConnectionContext, msg: ClientMessage) -> None:
        """拉取用户画像摘要（启动称呼引导）：只回是否有名字 + 名字 + 记忆开关。

        名字按「称呼 → 姓名 → 昵称 → 用户名」取第一个非空值——记忆提取 prompt
        可能写成其中任意一个 key；其余画像条目（城市/职业等）不对外暴露。
        """
        assert profile is not None  # 仅在装配了 profile 时注册（见下方注册块）
        name: str | None = None
        for key in _USER_NAME_PROFILE_KEYS:
            try:
                value = profile.get(key)
            except Exception:
                logger.exception("画像读取失败（get_profile，key={}）", key)
                continue
            if value and value.strip():
                name = value.strip()
                break
        enabled = True
        if memory_enabled is not None:
            try:
                enabled = bool(memory_enabled())
            except Exception:
                logger.exception("读取记忆提取开关失败（按开启返回）")
        await ctx.send_event(
            "profile",
            {"has_name": name is not None, "name": name, "memory_enabled": enabled},
            reply_to=msg.envelope.id,
        )

    async def on_note_assistant_message(
        ctx: ConnectionContext, msg: ClientMessage
    ) -> None:
        """补录前端本地展示的助手台词（启动称呼提问）：只写入会话历史，不触发回复。

        背景：问候/称呼提问由宠物面本地气泡展示，LLM 看不到；补录后用户对提问的
        回答才有上下文，后台记忆提取也能据此把"称呼"写进画像。
        未 hello（无 session）时静默忽略——不得因此创建空会话。
        """
        if not ctx.session_id:
            logger.debug("补录助手台词：连接尚无会话（未 hello），忽略")
            return
        session = sessions.get(ctx.session_id)
        if session is None:
            logger.debug("补录助手台词：会话 {} 不在内存，忽略", ctx.session_id)
            return
        data = cast(NoteAssistantMessageData, msg.data)
        text = (data.text or "").strip()
        if not text:
            return
        session.append_message("assistant", text)
        logger.info("补录助手台词（本地气泡）session={} len={}", session.id, len(text))

    dispatcher.register("ping", on_ping)
    dispatcher.register("hello", on_hello)
    dispatcher.register("user_message", on_user_message)
    dispatcher.register("interrupt", on_interrupt)
    dispatcher.register("load_history", on_load_history)
    dispatcher.register("delete_message", on_delete_message)
    dispatcher.register("pet_event", on_pet_event)
    dispatcher.register("behavior_done", on_behavior_done)
    dispatcher.register("env_update", on_env_update)
    dispatcher.register("note_assistant_message", on_note_assistant_message)
    if reminders is not None:
        dispatcher.register("get_reminders", on_get_reminders)
        dispatcher.register("ack_reminders", on_ack_reminders)
        dispatcher.register("get_reminder_history", on_get_reminder_history)
        dispatcher.register("delete_reminder_item", on_delete_reminder_item)
    if settings is not None:
        dispatcher.register("get_config", on_get_config)
        dispatcher.register("set_config", on_set_config)
        dispatcher.register("test_llm", on_test_llm)
    if memory_book is not None:
        dispatcher.register("memory_book_list", on_memory_book_list)
        dispatcher.register("memory_book_save", on_memory_book_save)
        dispatcher.register("memory_book_rename", on_memory_book_rename)
        dispatcher.register("memory_book_delete", on_memory_book_delete)
        dispatcher.register("memory_book_file_deleted", on_memory_book_file_deleted)
    if profile is not None:
        dispatcher.register("get_profile", on_get_profile)
    return dispatcher
