"""load_history 端到端测试（真实 uvicorn + SQLite + 模拟后端重启）。

场景：
1. 两轮对话 → load_history（指定/缺省 session_id、limit 截断）→ history 事件
   字段与顺序正确（时间正序、最近优先）；
2. 重启模拟（关闭 server → 用同一 pet.db 重开新 server）→ 旧会话历史仍可
   回填；在旧会话里继续对话时，LLM 收到的上下文包含长期记忆与画像（P3
   "重启后新对话上下文含记忆"的自动化验证；进程级真实验证见
   examples/memory_smoke.py）。
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
from backend.modules.memory.profile import ProfileStore
from backend.modules.memory.store import MemoryStore
from backend.shared.db import connect_db
from fakes import EchoLLMProvider, ScriptedProvider

TOKEN = "test-token-history"
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


async def start_server(
    history: HistoryStore,
    *,
    provider: Any | None = None,
    memories: MemoryStore | None = None,
    profile: ProfileStore | None = None,
) -> tuple[uvicorn.Server, asyncio.Task, int]:
    """在随机端口启动真实后端（会话历史接入 SQLite）。"""
    sessions = SessionManager(store=history)
    pipeline = ChatPipeline(
        provider=provider or EchoLLMProvider(delay=0.0),
        memories=memories,
        profile=profile,
    )
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


async def stop_server(server: uvicorn.Server, task: asyncio.Task) -> None:
    server.should_exit = True
    await task


async def recv(ws: websockets.WebSocketClientProtocol) -> dict:
    while True:
        raw = await asyncio.wait_for(ws.recv(), timeout=RECV_TIMEOUT)
        if isinstance(raw, bytes):
            continue  # 本测试未装配 TTS；防御性跳过二进制帧
        return json.loads(raw)


async def hello(ws: websockets.WebSocketClientProtocol) -> dict:
    await ws.send(
        make_msg("hello", {"token": TOKEN, "protocol_version": 1, "app_version": "test"})
    )
    return await recv(ws)


async def one_turn(ws: websockets.WebSocketClientProtocol, text: str, *, session_id: str | None = None) -> None:
    data: dict[str, Any] = {"text": text}
    if session_id is not None:
        data["session_id"] = session_id
    await ws.send(make_msg("user_message", data))
    while True:
        evt = await recv(ws)
        if evt["type"] == "state" and evt["data"]["state"] == "idle":
            return


async def load_history(
    ws: websockets.WebSocketClientProtocol, *, session_id: str | None = None, limit: int | None = None
) -> dict:
    data: dict[str, Any] = {}
    if session_id is not None:
        data["session_id"] = session_id
    if limit is not None:
        data["limit"] = limit
    await ws.send(make_msg("load_history", data))
    while True:
        evt = await recv(ws)
        if evt["type"] == "history":
            return evt


# ---------------------------------------------------------------- 场景 1


def test_load_history_returns_recent_messages_in_order(tmp_path) -> None:
    async def scenario() -> None:
        conn = connect_db(tmp_path / "pet.db")
        history = HistoryStore(conn)
        server, task, port = await start_server(history)
        try:
            async with websockets.connect(f"ws://127.0.0.1:{port}/ws") as ws:
                ack = await hello(ws)
                sid = ack["data"]["session_id"]

                await one_turn(ws, "第一轮：你好")
                await one_turn(ws, "第二轮：今天天气不错")

                # limit=2：最近两条（时间正序）
                evt = await load_history(ws, session_id=sid, limit=2)
                assert evt["data"]["session_id"] == sid
                recent = evt["data"]["messages"]
                assert len(recent) == 2
                assert [m["role"] for m in recent] == ["user", "assistant"]
                assert recent[0]["content"] == "第二轮：今天天气不错"
                for m in recent:
                    assert set(m) >= {"id", "role", "content", "created_at"}
                    assert isinstance(m["created_at"], int) and m["created_at"] > 0

                # limit=20：全部 4 条，时间正序
                evt = await load_history(ws, session_id=sid, limit=20)
                messages = evt["data"]["messages"]
                assert [m["role"] for m in messages] == ["user", "assistant", "user", "assistant"]
                assert messages[0]["content"] == "第一轮：你好"

                # 缺省 session_id：回填当前连接会话
                evt = await load_history(ws, limit=20)
                assert evt["data"]["session_id"] == sid
                assert len(evt["data"]["messages"]) == 4
        finally:
            await stop_server(server, task)
            conn.close()

    asyncio.run(scenario())


def test_load_history_unknown_session_returns_empty(tmp_path) -> None:
    async def scenario() -> None:
        conn = connect_db(tmp_path / "pet.db")
        history = HistoryStore(conn)
        server, task, port = await start_server(history)
        try:
            async with websockets.connect(f"ws://127.0.0.1:{port}/ws") as ws:
                await hello(ws)
                evt = await load_history(ws, session_id="不存在的会话", limit=10)
                assert evt["data"]["messages"] == []  # 回填是软功能：不报错
        finally:
            await stop_server(server, task)
            conn.close()

    asyncio.run(scenario())


# ---------------------------------------------------------------- 场景 2：重启


def test_history_and_memory_survive_restart(tmp_path) -> None:
    """重启后：旧会话历史可回填；继续对话时上下文含记忆与画像。"""

    async def scenario() -> None:
        db_file = tmp_path / "pet.db"

        # ---------- 第一次运行：两轮对话 ----------
        conn1 = connect_db(db_file)
        history1 = HistoryStore(conn1)
        server1, task1, port1 = await start_server(history1)
        old_sid = ""
        try:
            async with websockets.connect(f"ws://127.0.0.1:{port1}/ws") as ws:
                ack = await hello(ws)
                old_sid = ack["data"]["session_id"]
                await one_turn(ws, "我叫张三，请记住我")
                await one_turn(ws, "我最喜欢喝拿铁咖啡")
        finally:
            await stop_server(server1, task1)
            conn1.close()

        # ---------- 模拟重启：同一 pet.db 全新连接与服务 ----------
        conn2 = connect_db(db_file)
        history2 = HistoryStore(conn2)
        memory2 = MemoryStore(conn2)
        profile2 = ProfileStore(conn2)
        # 模拟"空闲后已提取"：记忆/画像落库（提取链路本身由 memory_service 单测覆盖）
        memory2.add("用户叫张三", "fact", 0.9)
        memory2.add("用户喜欢喝拿铁咖啡", "preference", 0.6)
        profile2.set("称呼", "张三")

        provider = ScriptedProvider(["收到啦"])
        server2, task2, port2 = await start_server(
            history2, provider=provider, memories=memory2, profile=profile2
        )
        try:
            async with websockets.connect(f"ws://127.0.0.1:{port2}/ws") as ws:
                await hello(ws)

                # 1) 旧会话历史仍在（重启后 load_history 回填）
                evt = await load_history(ws, session_id=old_sid, limit=20)
                assert [m["role"] for m in evt["data"]["messages"]] == [
                    "user",
                    "assistant",
                    "user",
                    "assistant",
                ]
                assert evt["data"]["messages"][0]["content"] == "我叫张三，请记住我"

                # 2) 在旧会话继续对话：上下文含画像 + 召回记忆
                await one_turn(ws, "你还记得我吗", session_id=old_sid)

            request = provider.seen_messages[0]
            assert request[0].role == "system"
            assert request[1].role == "system", "第二条 system 应为记忆注入块"
            block = request[1].content
            assert "[用户画像]" in block and "- 称呼：张三" in block
            assert "- 用户叫张三" in block and "- 用户喜欢喝拿铁咖啡" in block
            # 历史也一并带上（重启后恢复的 4 条 + 本轮 user），且指定会话 id
            roles = [m.role for m in request]
            assert roles == ["system", "system", "user", "assistant", "user", "assistant", "user"]
        finally:
            await stop_server(server2, task2)
            conn2.close()

    asyncio.run(scenario())
