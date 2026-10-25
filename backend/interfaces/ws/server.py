"""WS 端点：连接生命周期、消息循环、心跳（设计文档 §3.4 / §3.6）。

本模块同时把 application 的出站端口（ReplySink）实现为 WS 事件推送 ——
协议转换集中在这一层，业务层不感知 WS 细节。
"""

from __future__ import annotations

import asyncio
import secrets as _secrets
import uuid
from pathlib import Path
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
    from backend.application.search_service import SearchService
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
        #: 每个会话一条回复任务（2026-10-24：多对话并发）
        self._reply_tasks: dict[str, asyncio.Task[None]] = {}
        #: 前台会话：宠物气泡/语音/表情只跟它走（工作窗切换时更新）
        self.foreground_session_id: str | None = None

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

    def session_sink(self, session_id: str) -> "SessionReplySink":
        """给某个会话包一层出站端口：事件带 session_id，非前台抑制语音/表情。"""
        return SessionReplySink(self, session_id)

    async def spawn_reply(
        self, session_id: str, coro: Coroutine[Any, Any, None]
    ) -> asyncio.Task[None]:
        """启动该会话的回复任务；同一会话上一轮仍在跑时先取消它（不影响其它会话）。"""
        await self.cancel_reply(session_id)
        task = asyncio.create_task(self._guard_reply(coro))
        self._reply_tasks[session_id] = task

        def _cleanup(done: asyncio.Task[None]) -> None:
            if self._reply_tasks.get(session_id) is done:
                self._reply_tasks.pop(session_id, None)

        task.add_done_callback(_cleanup)
        return task

    def is_replying(self, session_id: str | None = None) -> bool:
        """是否有未完成的回复；传 session_id 时只查该会话。"""
        if session_id is not None:
            task = self._reply_tasks.get(session_id)
            return task is not None and not task.done()
        return any(not task.done() for task in self._reply_tasks.values())

    async def cancel_reply(self, session_id: str | None = None) -> bool:
        """取消指定会话（缺省全部）的回复并等待收尾；返回是否确有任务被取消。"""
        if session_id is not None:
            tasks = [self._reply_tasks.pop(session_id, None)]
        else:
            tasks = list(self._reply_tasks.values())
            self._reply_tasks.clear()
        cancelled = False
        for task in tasks:
            if task is None or task.done():
                continue
            cancelled = True
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
            except Exception:
                logger.exception("回复任务收尾时异常")
        return cancelled

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


class SessionReplySink:
    """按会话包一层：所有回合事件带 session_id；非前台会话不驱动宠物语音/表情。

    - token / reply_start / reply_end / sources / message_saved / notice / error
      / tool_call 原样加 session_id 后发送；
    - state / sentence / emotion / 二进制音频只在会话是前台时发送，
      避免两个对话同时说话、表情打架。
    """

    def __init__(self, ctx: ConnectionContext, session_id: str) -> None:
        self._ctx = ctx
        self._sid = session_id

    def _foreground(self) -> bool:
        focus = self._ctx.foreground_session_id
        return focus is None or focus == self._sid

    async def state(self, state: str) -> None:
        if self._foreground():
            await self._ctx.send_event("state", {"state": state, "session_id": self._sid})

    async def reply_start(self, message_id: str) -> None:
        await self._ctx.send_event(
            "reply_start", {"message_id": message_id, "session_id": self._sid}
        )

    async def message_saved(self, client_id: str, db_id: int, role: str) -> None:
        await self._ctx.send_event(
            "message_saved",
            {"client_id": client_id, "db_id": db_id, "role": role, "session_id": self._sid},
        )

    async def reasoning(self, message_id: str, text: str) -> None:
        await self._ctx.send_event(
            "reasoning", {"message_id": message_id, "text": text, "session_id": self._sid}
        )

    async def token(self, message_id: str, text: str) -> None:
        await self._ctx.send_event(
            "token", {"message_id": message_id, "text": text, "session_id": self._sid}
        )

    async def sentence(self, message_id: str, index: int, text: str) -> None:
        if self._foreground():
            await self._ctx.send_event(
                "sentence",
                {"message_id": message_id, "index": index, "text": text, "session_id": self._sid},
            )

    async def emotion(self, message_id: str, emotion: str, intensity: float) -> None:
        if self._foreground():
            await self._ctx.send_event(
                "emotion",
                {
                    "message_id": message_id,
                    "emotion": emotion,
                    "intensity": intensity,
                    "session_id": self._sid,
                },
            )

    async def reply_end(
        self, message_id: str, full_text: str, *, interrupted: bool = False
    ) -> None:
        data: dict[str, Any] = {
            "message_id": message_id,
            "full_text": full_text,
            "session_id": self._sid,
        }
        if interrupted:
            data["interrupted"] = True
        await self._ctx.send_event("reply_end", data)

    async def tool_call(self, tool_id: str, name: str, args: dict) -> None:
        # 后台对话不触发前端工具（避免替用户打开设置/工作台等）
        if not self._foreground():
            return
        await self._ctx.send_event(
            "tool_call", {"id": tool_id, "name": name, "args": args, "session_id": self._sid}
        )

    async def notice(self, code: str, message: str, level: str = "info") -> None:
        await self._ctx.send_event(
            "notice",
            {"code": code, "message": message, "level": level, "session_id": self._sid},
        )

    async def sources(self, message_id: str, items: list[dict]) -> None:
        await self._ctx.send_event(
            "sources", {"message_id": message_id, "items": items, "session_id": self._sid}
        )

    async def error(self, code: Any, message: str) -> None:
        await self._ctx.send_event(
            "error", {"code": str(code), "message": message, "session_id": self._sid}
        )

    async def send_binary(self, frame: bytes) -> None:
        if self._foreground():
            await self._ctx.send_binary(frame)


def create_app(
    *,
    dispatcher: Dispatcher,
    app_version: str,
    voice_factory: Callable[[], VoiceOut] | None = None,
    internal_token: str | None = None,
    search: SearchService | None = None,
) -> FastAPI:
    """创建 FastAPI 应用（/ws 对话端点 + /internal/* 主进程专用端点）。

    ``voice_factory``：每条连接构造一个连接级语音出站（VoiceOut）——失败降级
    状态随连接存活；None 表示本进程未启用语音（对话链路行为与 Phase 1 一致）。

    ``internal_token``：主进程专用内部凭据（PET_INTERNAL_TOKEN），与下发给渲染层
    的 WS token **刻意分离**——渲染进程即使拿到 WS token 也读不到 LLM Key。
    为 None 时内部端点整体禁用（一律 403）。

    ``search``：联网搜索用例（任务模式经内部端点复用）。None 时 search/fetch
    端点返回 503——任务模式那里只当"暂时不可用"处理。
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

    def _search_payload(result: dict[str, Any]) -> JSONResponse:
        """把 SearchService 的蛇形结果转成主进程用的驼峰契约（结构与 /internal/llm-key 一致）。

        ``sources`` 原样带过去：任务面板的引用悬浮卡片与对话模式共用同一份
        （站点 / 日期 / 标题 / 摘要），否则只能显示 URL。
        """
        sources: list[dict[str, Any]] = []
        raw_sources = result.get("sources")
        if isinstance(raw_sources, list):
            for fallback_index, item in enumerate(raw_sources[:50], start=1):
                if not isinstance(item, dict):
                    continue
                index = item.get("index")
                sources.append(
                    {
                        "index": index if isinstance(index, int) else fallback_index,
                        "title": str(item.get("title") or ""),
                        "url": str(item.get("url") or ""),
                        "snippet": str(item.get("snippet") or ""),
                        "site_name": str(item.get("site_name") or ""),
                        "date": str(item.get("date") or ""),
                    }
                )
        return JSONResponse(
            {
                "ok": bool(result.get("ok")),
                "code": str(result.get("code") or ""),
                "message": str(result.get("message") or ""),
                "modelContent": str(result.get("model_content") or ""),
                "sources": sources,
            },
            headers={"Cache-Control": "no-store"},
        )

    @app.post("/internal/search")
    async def internal_search(
        payload: dict[str, Any],
        x_pet_internal_token: str | None = Header(default=None, alias="X-Pet-Internal-Token"),
    ) -> JSONResponse:
        """任务模式的联网搜索：复用 SearchService 的开关 / 条数 / 格式化。

        开关仍是「设置 → 搜索」里的唯一口径（关闭时返回 search_disabled 说明）。
        """
        _require_internal(x_pet_internal_token)
        if search is None:
            raise HTTPException(status_code=503, detail="search unavailable")
        query = payload.get("query")
        result = await search.search_from_tool(
            {"query": query if isinstance(query, str) else ""}
        )
        return _search_payload(result)

    @app.post("/internal/fetch")
    async def internal_fetch(
        payload: dict[str, Any],
        x_pet_internal_token: str | None = Header(default=None, alias="X-Pet-Internal-Token"),
    ) -> JSONResponse:
        """任务模式的网页抓取：同样经 SearchService（开关、正文截断、错误翻译都在后端）。"""
        _require_internal(x_pet_internal_token)
        if search is None:
            raise HTTPException(status_code=503, detail="search unavailable")
        url = payload.get("url")
        result = await search.fetch_from_tool({"url": url if isinstance(url, str) else ""})
        return _search_payload(result)

    @app.post("/internal/files/extract")
    async def internal_files_extract(
        payload: dict[str, Any],
        x_pet_internal_token: str | None = Header(default=None, alias="X-Pet-Internal-Token"),
    ) -> JSONResponse:
        """任务模式的文件读取：复用对话附件的同一套读取与限额（2026-10-25）。

        只接受主进程调用（令牌鉴权）。文本/代码、Word、Excel、PDF 都走这里，
        任务模式不再自己维护第二套解析器；图片仍由主进程本地转 base64（更快）。
        """
        _require_internal(x_pet_internal_token)
        from backend.modules.files import (
            FileLimits,
            FileRef,
            FileRejected,
            read_attachments,
        )
        from backend.shared.config import load_config

        raw_paths = payload.get("paths")
        if (
            not isinstance(raw_paths, list)
            or not raw_paths
            or not all(isinstance(item, str) for item in raw_paths)
        ):
            return JSONResponse(
                {"ok": False, "code": "INVALID_PATH", "message": "请提供要读取的文件路径"},
                headers={"Cache-Control": "no-store"},
            )
        raw_pages = payload.get("pages")
        if raw_pages is not None and not isinstance(raw_pages, str):
            return JSONResponse(
                {"ok": False, "code": "PDF_PAGE_RANGE", "message": "页范围格式不正确"},
                headers={"Cache-Control": "no-store"},
            )

        try:
            files_cfg = load_config().files
            limits = FileLimits(
                max_chars=files_cfg.max_chars,
                max_bytes=files_cfg.max_bytes,
                max_per_turn=files_cfg.max_per_turn,
                max_image_bytes=files_cfg.max_image_bytes,
                allow_images=files_cfg.allow_images,
            )
        except Exception:  # noqa: BLE001 - 配置损坏不影响读取（退回默认限额）
            logger.warning("读取文件配置失败，内部端点改用默认限额")
            limits = FileLimits()

        refs = [FileRef(path) for path in raw_paths]
        try:
            attachments = await asyncio.to_thread(
                read_attachments, refs, limits, pages=raw_pages
            )
        except FileRejected as exc:
            return JSONResponse(
                {"ok": False, "code": exc.code, "message": exc.message},
                headers={"Cache-Control": "no-store"},
            )
        except Exception:  # noqa: BLE001 - 兜底：内部端点不把堆栈回给主进程
            logger.exception("内部文件抽取失败")
            return JSONResponse(
                {"ok": False, "code": "READ_FAILED", "message": "读取文件失败，请稍后再试～"},
                headers={"Cache-Control": "no-store"},
            )

        return JSONResponse(
            {
                "ok": True,
                "files": [
                    {
                        "name": item.name,
                        "text": item.text,
                        "chars": item.chars,
                        "imageUrl": item.image_url,
                        "mime": item.mime,
                    }
                    for item in attachments
                ],
            },
            headers={"Cache-Control": "no-store"},
        )

    @app.get("/internal/agent-config")
    async def internal_agent_config_get(
        x_pet_internal_token: str | None = Header(default=None, alias="X-Pet-Internal-Token"),
    ) -> JSONResponse:
        """任务模式配置（目前只有默认工作区）；空串 = 让主进程按平台默认解析。"""
        _require_internal(x_pet_internal_token)
        from backend.shared.config import load_config

        try:
            default_workspace = load_config().agent.default_workspace
        except Exception:  # noqa: BLE001 - 配置损坏：明确告知主进程，由它报错而不是静默换目录
            logger.warning("读取 agent 配置失败，内部端点标记 configError")
            return JSONResponse(
                {"defaultWorkspace": "", "configError": True},
                headers={"Cache-Control": "no-store"},
            )
        return JSONResponse(
            {"defaultWorkspace": default_workspace},
            headers={"Cache-Control": "no-store"},
        )

    @app.post("/internal/agent-config")
    async def internal_agent_config_set(
        payload: dict[str, Any],
        x_pet_internal_token: str | None = Header(default=None, alias="X-Pet-Internal-Token"),
    ) -> JSONResponse:
        """写回默认工作区（任务页「设为默认」用），走 save_config 保留注释与排版。"""
        _require_internal(x_pet_internal_token)
        from backend.shared.config import load_config, save_config

        raw = payload.get("defaultWorkspace")
        if not isinstance(raw, str):
            return JSONResponse(
                {"ok": False, "code": "INVALID_PATH", "message": "工作区路径格式不正确"},
                headers={"Cache-Control": "no-store"},
            )
        text = raw.strip()
        if text:
            if "\x00" in text or text.startswith("\\\\"):
                return JSONResponse(
                    {"ok": False, "code": "INVALID_PATH", "message": "不支持这个工作区路径"},
                    headers={"Cache-Control": "no-store"},
                )
            path = Path(text)
            if not path.is_absolute() or path.parent == path:
                return JSONResponse(
                    {
                        "ok": False,
                        "code": "INVALID_PATH",
                        "message": "工作区必须是绝对路径，且不能是磁盘根目录",
                    },
                    headers={"Cache-Control": "no-store"},
                )
            if not path.exists() or not path.is_dir():
                return JSONResponse(
                    {
                        "ok": False,
                        "code": "INVALID_PATH",
                        "message": "这个目录不存在或不是文件夹，请重新选择～",
                    },
                    headers={"Cache-Control": "no-store"},
                )

        try:
            config = load_config()
            config.agent.default_workspace = text
            save_config(config)
        except Exception:  # noqa: BLE001 - 配置损坏/写盘失败都回可读原因
            logger.exception("保存默认工作区失败")
            return JSONResponse(
                {"ok": False, "code": "SAVE_FAILED", "message": "保存默认工作区失败，请稍后再试～"},
                headers={"Cache-Control": "no-store"},
            )
        return JSONResponse(
            {"ok": True, "defaultWorkspace": text},
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
