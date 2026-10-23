"""WS 端点：连接生命周期、消息循环、心跳（设计文档 §3.4 / §3.6）。

本模块同时把 application 的出站端口（ReplySink）实现为 WS 事件推送 ——
协议转换集中在这一层，业务层不感知 WS 细节。
"""

from __future__ import annotations

import asyncio
import secrets as _secrets
import uuid
from typing import TYPE_CHECKING, Any, Callable, Coroutine

from fastapi import FastAPI, Header, HTTPException, WebSocket
from fastapi.responses import JSONResponse
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
    from backend.application.voice import VoiceOut
    from backend.interfaces.ws.dispatcher import Dispatcher


class ConnectionContext:
    """一条 WS 连接的运行时上下文。

    实现 application.chat_pipeline.ReplySink 出站端口（state / reply_start / token /
    emotion / sentence / reply_end / tool_call / error / send_binary），并提供通用
    send_event / send_error 与回复任务的生命周期管理。

    ``voice``（可选）：连接级语音出站（application.voice.VoiceOut），由装配层
    注入——失败降级状态跨轮存活于连接上（"本次连接内禁用 TTS"，任务书第 5 条）。
    """

    def __init__(self, ws: WebSocket, *, voice: VoiceOut | None = None) -> None:
        self.ws = ws
        self.voice = voice
        self.id = f"c_{uuid.uuid4().hex[:8]}"
        self.authed = False
        #: 连接角色（hello 里的 client_role；未 hello 前按 pet 兼容）——
        #: 设置页是唯一允许创建 program（免确认运行程序）条目的来源
        self.client_role = "pet"
        self.session_id: str | None = None
        self.close_request: tuple[int, str] | None = None
        self._send_lock = asyncio.Lock()
        self._reply_task: asyncio.Task[None] | None = None

    # ---------- ReplySink：对话流水线出站端口 ----------

    async def state(self, state: str) -> None:
        await self.send_event("state", {"state": state})

    async def reply_start(self, message_id: str) -> None:
        await self.send_event("reply_start", {"message_id": message_id})

    async def message_saved(self, client_id: str, db_id: int, role: str) -> None:
        """ReplySink 端口：消息已落库，把 DB 行 id 回给前端（工作模式单条删除）。"""
        await self.send_event(
            "message_saved", {"client_id": client_id, "db_id": db_id, "role": role}
        )

    async def reasoning(self, message_id: str, text: str) -> None:
        """ReplySink 端口：推理模型思考过程增量（工作模式折叠展示）。"""
        await self.send_event("reasoning", {"message_id": message_id, "text": text})

    async def token(self, message_id: str, text: str) -> None:
        await self.send_event("token", {"message_id": message_id, "text": text})

    async def sentence(self, message_id: str, index: int, text: str) -> None:
        """ReplySink 端口：一句完整文本（供 TTS 流水线/断句展示，§3.3）。"""
        await self.send_event(
            "sentence", {"message_id": message_id, "index": index, "text": text}
        )

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

    async def tool_call(self, tool_id: str, name: str, args: dict) -> None:
        """ReplySink 端口：本轮工具调用（§4.7；快通道命中或模型 tool_calls）。

        在对应回复的 reply_end 之后推送，字段对齐协议 ToolCallData
        （id / name / args）；前端按 name 执行（如 open_settings → 打开设置窗）。
        """
        await self.send_event("tool_call", {"id": tool_id, "name": name, "args": args})

    async def notice(self, code: str, message: str, level: str = "info") -> None:
        """ReplySink 端口：一次性提示（如文件分析丢弃了旧上下文）。

        不进入回复正文、不进历史、不参与 TTS；前端在聊天面板上方短暂展示。
        """
        await self.send_event("notice", {"code": code, "message": message, "level": level})

    async def sources(self, message_id: str, items: list[dict]) -> None:
        """ReplySink 端口：本轮搜索来源的结构化信息（工作窗悬浮卡片用）。"""
        await self.send_event("sources", {"message_id": message_id, "items": items})

    async def error(self, code: str, message: str) -> None:
        """ReplySink 端口：把流水线的业务错误（如 LlmError / TTS_FAILED）推给前端。"""
        await self.send_error(code, message)

    async def send_binary(self, frame: bytes) -> None:
        """ReplySink 端口：发送一条二进制帧（音频，§3.5；与文本帧共用连接）。"""
        async with self._send_lock:
            try:
                await self.ws.send_bytes(frame)
            except Exception:
                # 下行尽力而为：连接已关闭时由消息循环统一感知并清理
                logger.debug("发送二进制帧失败（连接可能已关闭），{} 字节", len(frame))

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


def create_app(
    *,
    dispatcher: Dispatcher,
    app_version: str,
    voice_factory: Callable[[], VoiceOut] | None = None,
    internal_token: str | None = None,
) -> FastAPI:
    """创建 FastAPI 应用（/ws 对话端点 + /internal/* 主进程专用端点）。

    ``voice_factory``：每条连接构造一个连接级语音出站（VoiceOut）——失败降级
    状态随连接存活；None 表示本进程未启用语音（对话链路行为与 Phase 1 一致）。

    ``internal_token``：主进程专用内部凭据（PET_INTERNAL_TOKEN），与下发给渲染层
    的 WS token **刻意分离**——渲染进程即使拿到 WS token 也读不到 LLM Key。
    为 None 时内部端点整体禁用（一律 403）。
    """
    app = FastAPI(title="AI Desktop Pet Backend", version=app_version)

    def _require_internal(token: str | None) -> None:
        if not internal_token or not token or not _secrets.compare_digest(token, internal_token):
            raise HTTPException(status_code=403, detail="forbidden")

    @app.get("/internal/llm-key")
    async def internal_llm_key(
        x_pet_internal_token: str | None = Header(default=None, alias="X-Pet-Internal-Token"),
    ) -> JSONResponse:
        """把当前对话模型的 Key / 端点 / 模型名交给主进程（任务模式复用）。

        只返回内存中的明文（不落盘、不写日志）；渲染层无法访问该端点。
        """
        _require_internal(x_pet_internal_token)
        from backend.shared.config import load_config
        from backend.shared.secrets import get_llm_key

        key = get_llm_key()
        try:
            llm = load_config().llm
            base_url, model = llm.base_url, llm.model
        except Exception:  # noqa: BLE001 - 配置损坏不影响端点（返回未配置态）
            logger.warning("读取 LLM 配置失败，内部端点返回空端点/模型")
            base_url, model = "", ""
        return JSONResponse(
            {"configured": bool(key), "key": key or "", "baseUrl": base_url, "model": model},
            headers={"Cache-Control": "no-store"},
        )

    @app.websocket("/ws")
    async def ws_endpoint(ws: WebSocket) -> None:
        await ws.accept()
        ctx = ConnectionContext(ws, voice=voice_factory() if voice_factory else None)
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
