"""会话主链路：心跳、鉴权、用户消息、打断、历史与消息补录。"""

from __future__ import annotations

from typing import TYPE_CHECKING, cast

from loguru import logger

from backend.application.chat_pipeline import ChatPipeline, TurnOptions
from backend.application.session import SessionManager
from backend.interfaces.ws.auth import verify_token
from backend.interfaces.ws.handlers.sinks import _ConnectionSink, _ReminderSink
from backend.interfaces.ws.handlers.types import HandlerRegistry
from backend.interfaces.ws.protocol import (
    PROTOCOL_VERSION,
    ConversationDeletedData,
    ConversationFocusData,
    ConversationRenamedData,
    ConversationSummaryData,
    ConversationsData,
    DeleteConversationData,
    DeleteMessageData,
    HelloAckData,
    HelloData,
    InterruptData,
    ListConversationsData,
    LoadHistoryData,
    NoteAssistantMessageData,
    RenameConversationData,
    UserMessageData,
)
from backend.modules.files import FileRef
from backend.shared.errors import ErrorCode

if TYPE_CHECKING:  # 避免与 server 运行时循环 import（类型注解专用）
    from backend.application.reminder_service import ReminderService
    from backend.interfaces.ws.server import ConnectionContext
    from backend.modules.behavior.engine import BehaviorEngine
    from backend.modules.chat.history import HistoryStore


def register_chat_handlers(
    registry: HandlerRegistry,
    *,
    pipeline: ChatPipeline,
    sessions: SessionManager,
    token: str,
    app_version: str,
    engine: BehaviorEngine | None = None,
    history: HistoryStore | None = None,
    reminders: ReminderService | None = None,
) -> None:
    """注册会话主链路的处理器。"""

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
        ctx.foreground_session_id = session.id
        await ctx.spawn_reply(
            session.id,
            pipeline.run_turn(
                ctx.session_sink(session.id),
                session=session,
                user_text=text,
                voice=ctx.voice,
                attachments=attachments,
                options=(
                    TurnOptions(
                        search=data.options.search,
                        teaching=data.options.teaching,
                    )
                    if data.options is not None
                    else None
                ),
                client_id=data.client_id,
            )
        )

    async def on_interrupt(ctx: ConnectionContext, msg: ClientMessage) -> None:
        """打断（§7.2）：取消指定会话（缺省前台）的回复任务。

        LLM 流与 TTS 合成同属该任务的取消链——流水线收到取消后先清空 TTS
        队列、停止推帧（已合成的帧不再推），再推 reply_end{interrupted} 与
        state:idle。因此本处只需取消回复任务本身。
        """
        data = cast(InterruptData, msg.data)
        target = data.session_id or ctx.foreground_session_id
        await ctx.cancel_reply(target)

    async def on_conversation_focus(ctx: ConnectionContext, msg: ClientMessage) -> None:
        """工作窗切换对话：更新前台会话（决定宠物语音/表情跟谁走）。"""
        data = cast(ConversationFocusData, msg.data)
        if data.session_id:
            ctx.foreground_session_id = data.session_id

    async def on_list_conversations(ctx: ConnectionContext, msg: ClientMessage) -> None:
        """列出有消息的对话（工作窗「对话」左栏）。"""
        _ = cast(ListConversationsData, msg.data)
        items: list[ConversationSummaryData] = []
        if history is not None:
            for row in history.list_conversations():
                items.append(
                    ConversationSummaryData(
                        id=str(row["id"]),
                        title=str(row["title"]),
                        created_at=int(row["created_at"]),
                        updated_at=int(row["updated_at"]),
                        message_count=int(row["message_count"]),
                    )
                )
        await ctx.send_event(
            "conversations", ConversationsData(items=items), reply_to=msg.envelope.id
        )

    async def on_rename_conversation(ctx: ConnectionContext, msg: ClientMessage) -> None:
        """改对话标题（1–50 字）。"""
        data = cast(RenameConversationData, msg.data)
        title = (data.title or "").strip()
        ok = False
        if history is not None and 0 < len(title) <= 50:
            ok = history.rename_session(data.id, title)
        await ctx.send_event(
            "conversation_renamed",
            ConversationRenamedData(id=data.id, title=title, ok=ok),
            reply_to=msg.envelope.id,
        )

    async def on_delete_conversation(ctx: ConnectionContext, msg: ClientMessage) -> None:
        """删除对话及全部消息；正在回复的当前会话不允许删（避免流写回已删库）。"""
        data = cast(DeleteConversationData, msg.data)
        if ctx.is_replying(data.id):
            await ctx.send_event(
                "conversation_deleted",
                ConversationDeletedData(id=data.id, ok=False),
                reply_to=msg.envelope.id,
            )
            return
        ok = history.delete_session(data.id) if history is not None else False
        if ok:
            sessions.remove(data.id)
            if ctx.session_id == data.id:
                ctx.session_id = ""
        await ctx.send_event(
            "conversation_deleted",
            ConversationDeletedData(id=data.id, ok=ok),
            reply_to=msg.envelope.id,
        )

    async def on_delete_message(ctx: ConnectionContext, msg: ClientMessage) -> None:
        """删除当前会话的单条消息（工作模式，2026-10-18）。

        - 只按 ``ctx.session_id + id`` 删，跨会话/不存在的 id 一律 ok=false；
        - 删除后重建会话内存上下文，保证模型下一轮不再看到该消息；
        - 不联动删除“配对”的另一条（用户定稿：删单条，不删整轮）。
        """
        data = cast(DeleteMessageData, msg.data)
        session_id = (data.session_id or ctx.session_id or "").strip()
        session = sessions.get(session_id) if session_id else None
        if session is None and session_id:
            session = sessions.start(session_id)  # 从库恢复（切换到旧对话后删消息）
        if session is None or history is None:
            await ctx.send_event(
                "message_deleted",
                {"id": data.id, "ok": False, "session_id": session_id},
            )
            return
        ok = history.delete_message(session.id, data.id)
        if ok:
            session.reload_history()
        await ctx.send_event(
            "message_deleted", {"id": data.id, "ok": ok, "session_id": session.id}
        )
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

    registry.register("ping", on_ping)
    registry.register("hello", on_hello)
    registry.register("user_message", on_user_message)
    registry.register("interrupt", on_interrupt)
    registry.register("conversation_focus", on_conversation_focus)
    registry.register("load_history", on_load_history)
    registry.register("delete_message", on_delete_message)
    registry.register("list_conversations", on_list_conversations)
    registry.register("rename_conversation", on_rename_conversation)
    registry.register("delete_conversation", on_delete_conversation)
    registry.register("note_assistant_message", on_note_assistant_message)
