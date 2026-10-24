"""对话列表端到端（2026-10-24）：真实 uvicorn + SQLite。

覆盖：
- 多会话各自落库，list_conversations 只返回有消息的会话（空会话过滤）；
- 首条用户消息自动标题、按最后消息时间倒序；
- rename_conversation / delete_conversation 的事件回执与库状态；
- 删除后 load_history 为空，继续发消息会重新建会话。
"""

from __future__ import annotations

import asyncio
import json
import uuid
from typing import Any

import uvicorn
import websockets

from backend.application.chat_pipeline import ChatPipeline
from backend.application.session import SessionManager
from backend.interfaces.ws.dispatcher import build_dispatcher
from backend.interfaces.ws.server import create_app
from backend.modules.chat.history import HistoryStore
from backend.shared.db import connect_db
from fakes import EchoLLMProvider

TOKEN = "test-token-conversations"
RECV_TIMEOUT = 8.0


def make_msg(msg_type: str, data: dict) -> str:
    return json.dumps(
        {
            "v": 1,
            "id": f"t_{uuid.uuid4().hex[:8]}",
            "reply_to": None,
            "type": msg_type,
            "ts": 0,
            "data": data,
        }
    )


async def start_server(history: HistoryStore) -> tuple[uvicorn.Server, asyncio.Task, int]:
    sessions = SessionManager(store=history)
    pipeline = ChatPipeline(provider=EchoLLMProvider(delay=0.0))
    dispatcher = build_dispatcher(
        pipeline=pipeline,
        sessions=sessions,
        token=TOKEN,
        app_version="test",
        history=history,
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


async def recv(ws: websockets.WebSocketClientProtocol) -> dict:
    while True:
        raw = await asyncio.wait_for(ws.recv(), timeout=RECV_TIMEOUT)
        if isinstance(raw, bytes):
            continue
        return json.loads(raw)


async def hello(ws: websockets.WebSocketClientProtocol) -> None:
    await ws.send(
        make_msg("hello", {"token": TOKEN, "protocol_version": 1, "app_version": "test"})
    )
    while True:
        evt = await recv(ws)
        if evt["type"] == "hello_ack":
            return


async def one_turn(
    ws: websockets.WebSocketClientProtocol, text: str, *, session_id: str
) -> None:
    await ws.send(make_msg("user_message", {"text": text, "session_id": session_id}))
    while True:
        evt = await recv(ws)
        if evt["type"] == "state" and evt["data"]["state"] == "idle":
            return


async def request(
    ws: websockets.WebSocketClientProtocol, msg_type: str, data: dict, expect: str
) -> dict:
    await ws.send(make_msg(msg_type, data))
    while True:
        evt = await recv(ws)
        if evt["type"] == expect:
            return evt["data"]


def test_conversations_e2e(tmp_path) -> None:
    async def scenario() -> None:
        conn = connect_db(tmp_path / "pet.db")
        history = HistoryStore(conn)
        server, task, port = await start_server(history)
        try:
            async with websockets.connect(f"ws://127.0.0.1:{port}/ws") as ws:
                await hello(ws)
                await one_turn(ws, "第一个对话的第一句", session_id="s1")
                await one_turn(ws, "第二个对话的问题", session_id="s2")
                await one_turn(ws, "第二个对话的追问", session_id="s2")

                listed = (await request(ws, "list_conversations", {}, "conversations"))["items"]
                ids = [item["id"] for item in listed]
                assert ids == ["s2", "s1"]
                assert listed[0]["title"] == "第二个对话的问题"
                assert listed[0]["message_count"] == 4

                renamed = await request(
                    ws,
                    "rename_conversation",
                    {"id": "s1", "title": "我的旧对话"},
                    "conversation_renamed",
                )
                assert renamed["ok"] is True
                assert history.get_session("s1")["title"] == "我的旧对话"

                deleted = await request(
                    ws, "delete_conversation", {"id": "s1"}, "conversation_deleted"
                )
                assert deleted["ok"] is True
                assert history.session_exists("s1") is False
                assert [item["id"] for item in history.list_conversations()] == ["s2"]

                # 删除后继续用旧 id 发消息：按新会话重建，历史为空
                await one_turn(ws, "重建", session_id="s1")
                assert history.session_exists("s1") is True
                rebuilt = history.recent_messages("s1")
                assert len(rebuilt) >= 2
                assert rebuilt[0]["role"] == "user"
                assert rebuilt[0]["content"] == "重建"
        finally:
            server.should_exit = True
            await task
            conn.close()

    asyncio.run(scenario())
