"""消息类型 → 用例的路由注册表（设计文档 §2.3 dispatcher）。

原则：协议内但未实现的事件类型，统一回 ``error{code:"NOT_IMPLEMENTED"}``，
禁止静默丢弃。
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Awaitable, Callable, cast

from loguru import logger

from backend.application.chat_pipeline import ChatPipeline
from backend.application.session import SessionManager
from backend.interfaces.ws.auth import verify_token
from backend.interfaces.ws.protocol import (
    PROTOCOL_VERSION,
    ClientMessage,
    HelloAckData,
    HelloData,
    UserMessageData,
)
from backend.shared.errors import ErrorCode, ProtocolError

if TYPE_CHECKING:  # 避免与 server 运行时循环 import（类型注解专用）
    from backend.interfaces.ws.server import ConnectionContext

Handler = Callable[["ConnectionContext", ClientMessage], Awaitable[None]]


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
) -> Dispatcher:
    """装配默认事件路由（interfaces → application 的唯一接线点）。"""
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
        logger.info("连接 {} 鉴权通过，session={}", ctx.id, session.id)

    async def on_user_message(ctx: ConnectionContext, msg: ClientMessage) -> None:
        """用户消息：以后台任务运行对话流水线，消息循环保持可用（可即时处理 interrupt）。"""
        data = cast(UserMessageData, msg.data)
        text = data.text.strip()
        if not text:
            await ctx.send_error(
                ErrorCode.BAD_MESSAGE, "user_message.text 不能为空", reply_to=msg.envelope.id
            )
            return
        session = sessions.start(data.session_id or ctx.session_id)
        ctx.session_id = session.id
        await ctx.spawn_reply(pipeline.run_turn(ctx, session=session, user_text=text))

    async def on_interrupt(ctx: ConnectionContext, msg: ClientMessage) -> None:
        """打断：取消当前流式回复（reply_end{interrupted}/state:idle 由流水线收尾推送）。"""
        await ctx.cancel_reply()

    dispatcher.register("ping", on_ping)
    dispatcher.register("hello", on_hello)
    dispatcher.register("user_message", on_user_message)
    dispatcher.register("interrupt", on_interrupt)
    return dispatcher
