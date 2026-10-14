"""WS 端点：连接生命周期、消息循环、心跳（设计文档 §3.4 / §3.6）。

本模块同时把 application 的出站端口（ReplySink）实现为 WS 事件推送 ——
协议转换集中在这一层，业务层不感知 WS 细节。
"""

from __future__ import annotations

import asyncio
import uuid
from typing import TYPE_CHECKING, Any, Coroutine

from fastapi import FastAPI, WebSocket
from loguru import logger
from starlette.websockets import WebSocketDisconnect

from backend.interfaces.ws.protocol import (
    ClientMessage,
    make_envelope,
    parse_client_message,
    serialize_envelope,
)
from backend.shared.errors import ErrorCode, ProtocolError

if TYPE_CHECKING:  # 避免与 dispatcher 运行时循环 import（类型注解专用）
    from backend.interfaces.ws.dispatcher import Dispatcher


class ConnectionContext:
    """一条 WS 连接的运行时上下文。

    实现 application.chat_pipeline.ReplySink 出站端口（state / reply_start / token /
    emotion / reply_end），并提供通用 send_event / send_error 与回复任务的生命周期管理。
    """

    def __init__(self, ws: WebSocket) -> None:
        self.ws = ws
        self.id = f"c_{uuid.uuid4().hex[:8]}"
        self.authed = False
        self.session_id: str | None = None
        self.close_request: tuple[int, str] | None = None
        self._send_lock = asyncio.Lock()
        self._reply_task: asyncio.Task[None] | None = None

    # ---------- ReplySink：对话流水线出站端口 ----------

    async def state(self, state: str) -> None:
        await self.send_event("state", {"state": state})

    async def reply_start(self, message_id: str) -> None:
        await self.send_event("reply_start", {"message_id": message_id})

    async def token(self, message_id: str, text: str) -> None:
        await self.send_event("token", {"message_id": message_id, "text": text})

    async def emotion(self, message_id: str, emotion: str, intensity: float) -> None:
        await self.send_event(
            "emotion", {"message_id": message_id, "emotion": emotion, "intensity": intensity}
        )

    async def reply_end(
        self, message_id: str, full_text: str, *, interrupted: bool = False
    ) -> None:
        data: dict[str, Any] = {"message_id": message_id, "full_text": full_text}
        if interrupted:
            data["interrupted"] = True
        await self.send_event("reply_end", data)

    # ---------- 通用发送 ----------

    async def send_event(
        self,
        msg_type: str,
        data: Any = None,
        *,
        reply_to: str | None = None,
    ) -> None:
        """构造信封并发送一条文本帧（发送串行化）。"""
        raw = serialize_envelope(make_envelope(msg_type, data, reply_to=reply_to))
        async with self._send_lock:
            try:
                await self.ws.send_text(raw)
            except Exception:
                # 下行尽力而为：连接已关闭时由消息循环统一感知并清理
                logger.debug("发送 {} 事件失败（连接可能已关闭）", msg_type)

    async def send_error(
        self,
        code: ErrorCode | str,
        message: str,
        *,
        fatal: bool = False,
        reply_to: str | None = None,
    ) -> None:
        payload: dict[str, Any] = {"code": str(code), "message": message}
        if fatal:
            payload["fatal"] = True
        await self.send_event("error", payload, reply_to=reply_to)

    # ---------- 连接 / 任务生命周期 ----------

    def request_close(self, code: int, reason: str = "") -> None:
        """请求消息循环关闭连接（发送完剩余事件后生效）。"""
        self.close_request = (code, reason)

    async def spawn_reply(self, coro: Coroutine[Any, Any, None]) -> asyncio.Task[None]:
        """启动一轮对话后台任务；若上一轮仍在流式中，先取消并等待其收尾。"""
        await self.cancel_reply()
        task = asyncio.create_task(self._guard_reply(coro))
        self._reply_task = task
        return task

    async def cancel_reply(self) -> bool:
        """取消当前回复任务并等待其收尾；返回是否确有任务被取消。"""
        task = self._reply_task
        self._reply_task = None
        if task is None or task.done():
            return False
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass
        except Exception:
            logger.exception("回复任务收尾时异常")
        return True

    async def shutdown(self) -> None:
        """连接结束时清理：取消未完成的回复任务。"""
        await self.cancel_reply()

    async def _guard_reply(self, coro: Coroutine[Any, Any, None]) -> None:
        """兜住流水线任务的异常，避免 Task exception was never retrieved。"""
        try:
            await coro
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("对话流水线执行异常")
            await self.send_error(ErrorCode.INTERNAL, "对话处理失败")


def create_app(*, dispatcher: Dispatcher, app_version: str) -> FastAPI:
    """创建 FastAPI 应用（目前仅 /ws 端点）。"""
    app = FastAPI(title="AI Desktop Pet Backend", version=app_version)

    @app.websocket("/ws")
    async def ws_endpoint(ws: WebSocket) -> None:
        await ws.accept()
        ctx = ConnectionContext(ws)
        logger.info("WS 连接建立 {}", ctx.id)
        try:
            await _message_loop(ws, ctx, dispatcher)
        except WebSocketDisconnect:
            logger.info("WS 连接断开 {}", ctx.id)
        except Exception:
            logger.exception("WS 连接异常终止 {}", ctx.id)
        finally:
            await ctx.shutdown()
            logger.info("WS 连接清理完成 {}", ctx.id)

    return app


async def _message_loop(ws: WebSocket, ctx: ConnectionContext, dispatcher: Dispatcher) -> None:
    """逐帧接收 → 解析 → 分发的消息循环。"""
    while True:
        message = await ws.receive()
        if message["type"] == "websocket.disconnect":
            return

        raw = message.get("text")
        if raw is None:
            # 二进制帧（Phase 2 音频，§3.5）：不静默丢弃
            await ctx.send_error(ErrorCode.NOT_IMPLEMENTED, "二进制帧（音频）尚未实现")
            continue

        await _handle_raw(ctx, dispatcher, raw)

        if ctx.close_request is not None:
            code, reason = ctx.close_request
            try:
                await ws.close(code=code, reason=reason)
            except Exception:
                logger.debug("关闭连接失败（可能已断开）")
            return


async def _handle_raw(ctx: ConnectionContext, dispatcher: Dispatcher, raw: str) -> None:
    """解析并处理一条文本帧。"""
    try:
        msg: ClientMessage = parse_client_message(raw)
    except ProtocolError as exc:
        await ctx.send_error(exc.code, exc.message, fatal=exc.fatal)
        if exc.fatal:
            ctx.request_close(1002, "protocol error")
        return

    if not ctx.authed and msg.envelope.type != "hello":
        await ctx.send_error(
            ErrorCode.HELLO_REQUIRED, "请先发送 hello 完成鉴权", reply_to=msg.envelope.id
        )
        return

    await dispatcher.dispatch(ctx, msg)
