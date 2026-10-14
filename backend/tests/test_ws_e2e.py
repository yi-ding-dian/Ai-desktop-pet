"""端到端测试：真实 uvicorn（动态端口）+ websockets 客户端。

覆盖：hello 鉴权（成功/失败/版本不匹配/未鉴权）、心跳、Echo 流水线事件顺序、
中断收尾、未实现事件兜底、未知事件类型。
"""

from __future__ import annotations

import asyncio
import json
import uuid

import pytest
import uvicorn
import websockets

from backend.application.chat_pipeline import ChatPipeline
from backend.application.session import SessionManager
from backend.interfaces.ws.dispatcher import build_dispatcher
from backend.interfaces.ws.server import create_app
from fakes import EchoLLMProvider

TOKEN = "test-token-123"
RECV_TIMEOUT = 8.0


def make_msg(msg_type: str, data: dict, *, reply_to: str | None = None) -> str:
    return json.dumps(
        {
            "v": 1,
            "id": f"t_{uuid.uuid4().hex[:8]}",
            "reply_to": reply_to,
            "type": msg_type,
            "ts": 0,
            "data": data,
        }
    )


async def start_server(delay: float = 0.0) -> tuple[uvicorn.Server, asyncio.Task, int]:
    """在随机端口启动真实后端，返回 (server, serve_task, port)。"""
    sessions = SessionManager()
    pipeline = ChatPipeline(provider=EchoLLMProvider(delay=delay))
    dispatcher = build_dispatcher(
        pipeline=pipeline, sessions=sessions, token=TOKEN, app_version="test"
    )
    app = create_app(dispatcher=dispatcher, app_version="test")
    config = uvicorn.Config(
        app,
        host="127.0.0.1",
        port=0,
        log_config=None,
        log_level="warning",
        access_log=False,
        lifespan="off",
    )
    server = uvicorn.Server(config)
    task = asyncio.create_task(server.serve())
    while not server.started:
        if task.done():
            await task
        await asyncio.sleep(0.01)
    port = int(server.servers[0].sockets[0].getsockname()[1])
    return server, task, port


async def stop_server(server: uvicorn.Server, task: asyncio.Task) -> None:
    server.should_exit = True
    await task


async def recv(ws: websockets.WebSocketClientProtocol) -> dict:
    return json.loads(await asyncio.wait_for(ws.recv(), timeout=RECV_TIMEOUT))


async def hello(ws: websockets.WebSocketClientProtocol, token: str = TOKEN, version: int = 1) -> dict:
    await ws.send(make_msg("hello", {"token": token, "protocol_version": version, "app_version": "test"}))
    return await recv(ws)


# ---------------------------------------------------------------- 正常链路


def test_full_echo_conversation() -> None:
    async def scenario() -> None:
        server, task, port = await start_server()
        try:
            async with websockets.connect(f"ws://127.0.0.1:{port}/ws") as ws:
                ack = await hello(ws)
                assert ack["type"] == "hello_ack"
                assert ack["data"]["ok"] is True
                assert ack["data"]["session_id"]

                # 心跳
                await ws.send(make_msg("ping", {}))
                assert (await recv(ws))["type"] == "pong"

                # 一轮对话：收完整事件流（以 state:idle 收尾）
                await ws.send(make_msg("user_message", {"text": "你好"}))
                events = []
                while True:
                    evt = await recv(ws)
                    events.append(evt)
                    if evt["type"] == "state" and evt["data"]["state"] == "idle":
                        break

                types = [e["type"] for e in events]
                assert types[0] == "state" and events[0]["data"]["state"] == "thinking"
                assert types[1] == "reply_start"
                assert types[-2] == "reply_end"
                assert types[-1] == "state" and events[-1]["data"]["state"] == "idle"
                assert set(types[2:-2]) <= {"token", "emotion"}

                emotions = [e["data"]["emotion"] for e in events if e["type"] == "emotion"]
                assert emotions == ["happy", "thinking", "neutral"]

                tokens = "".join(e["data"]["text"] for e in events if e["type"] == "token")
                reply_end = next(e for e in events if e["type"] == "reply_end")
                assert tokens == reply_end["data"]["full_text"]
                assert "<emo" not in tokens

                # 未实现事件：回 NOT_IMPLEMENTED，不静默丢弃
                await ws.send(make_msg("get_config", {}))
                err = await recv(ws)
                assert err["type"] == "error"
                assert err["data"]["code"] == "NOT_IMPLEMENTED"

                # 未知事件类型
                await ws.send(make_msg("nope", {}))
                err = await recv(ws)
                assert err["type"] == "error"
                assert err["data"]["code"] == "UNKNOWN_TYPE"
        finally:
            await stop_server(server, task)

    asyncio.run(scenario())


# ---------------------------------------------------------------- 中断（§7.2）


def test_interrupt_stops_stream() -> None:
    async def scenario() -> None:
        server, task, port = await start_server(delay=0.02)
        try:
            async with websockets.connect(f"ws://127.0.0.1:{port}/ws") as ws:
                await hello(ws)
                await ws.send(make_msg("user_message", {"text": "你好"}))

                # 等流水线进入流式阶段
                for _ in range(3):
                    await recv(ws)

                await ws.send(make_msg("interrupt", {}))
                interrupted = None
                while True:
                    evt = await recv(ws)
                    if evt["type"] == "reply_end":
                        interrupted = evt["data"].get("interrupted", False)
                        break
                assert interrupted is True

                idle = await recv(ws)
                assert idle["type"] == "state" and idle["data"]["state"] == "idle"

                # 打断后连接仍可用（再次对话）
                await ws.send(make_msg("user_message", {"text": "还在吗"}))
                first = await recv(ws)
                assert first["type"] == "state" and first["data"]["state"] == "thinking"
        finally:
            await stop_server(server, task)

    asyncio.run(scenario())


# ---------------------------------------------------------------- 鉴权分支（§3.4）


def test_hello_required_before_auth() -> None:
    async def scenario() -> None:
        server, task, port = await start_server()
        try:
            async with websockets.connect(f"ws://127.0.0.1:{port}/ws") as ws:
                await ws.send(make_msg("user_message", {"text": "hi"}))
                err = await recv(ws)
                assert err["type"] == "error"
                assert err["data"]["code"] == "HELLO_REQUIRED"
        finally:
            await stop_server(server, task)

    asyncio.run(scenario())


def test_bad_token_is_fatal_and_closes() -> None:
    async def scenario() -> None:
        server, task, port = await start_server()
        try:
            async with websockets.connect(f"ws://127.0.0.1:{port}/ws") as ws:
                ack = await hello(ws, token="wrong-token")
                assert ack["type"] == "hello_ack" and ack["data"]["ok"] is False

                err = await recv(ws)
                assert err["type"] == "error"
                assert err["data"]["code"] == "AUTH_FAILED"
                assert err["data"]["fatal"] is True

                with pytest.raises(websockets.exceptions.ConnectionClosed):
                    await asyncio.wait_for(ws.recv(), timeout=RECV_TIMEOUT)
        finally:
            await stop_server(server, task)

    asyncio.run(scenario())


def test_version_mismatch_is_fatal_and_closes() -> None:
    async def scenario() -> None:
        server, task, port = await start_server()
        try:
            async with websockets.connect(f"ws://127.0.0.1:{port}/ws") as ws:
                ack = await hello(ws, version=99)
                assert ack["type"] == "hello_ack" and ack["data"]["ok"] is False

                err = await recv(ws)
                assert err["type"] == "error"
                assert err["data"]["code"] == "VERSION_MISMATCH"
                assert err["data"]["fatal"] is True

                with pytest.raises(websockets.exceptions.ConnectionClosed):
                    await asyncio.wait_for(ws.recv(), timeout=RECV_TIMEOUT)
        finally:
            await stop_server(server, task)

    asyncio.run(scenario())
