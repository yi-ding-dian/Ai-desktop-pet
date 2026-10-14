"""WS 冒烟测试：真实跑通全链路。

流程：拉起后端子进程 → 逐行解析 stdout 的 PET_READY 握手行 → WS 连接 →
hello 鉴权 → ping/pong 心跳 → user_message → 打印完整事件流（并校验）→
未实现事件兜底 → 退出清理。

用法（项目根目录）：
    backend/.venv/bin/python backend/examples/ws_smoke.py
"""

from __future__ import annotations

import asyncio
import json
import os
import queue
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from pathlib import Path

import websockets

PROJECT_ROOT = Path(__file__).resolve().parents[2]  # examples → backend → 项目根
READY_PREFIX = "PET_READY "
STARTUP_TIMEOUT = 20.0
RECV_TIMEOUT = 10.0
PROTOCOL_VERSION = 1


def make_msg(msg_type: str, data: dict) -> str:
    """构造客户端消息（§3.1 信封）。"""
    return json.dumps(
        {
            "v": PROTOCOL_VERSION,
            "id": f"t_{uuid.uuid4().hex[:8]}",
            "reply_to": None,
            "type": msg_type,
            "ts": int(time.time() * 1000),
            "data": data,
        }
    )


def start_backend() -> tuple[subprocess.Popen[str], dict]:
    """拉起后端子进程并解析 READY 握手行，返回 (进程, READY 负载)。"""
    env = dict(os.environ)
    env.pop("PET_TOKEN", None)  # 强制走开发模式（READY 行携带 token）
    env["PET_DATA_DIR"] = tempfile.mkdtemp(prefix="pet-smoke-")
    print(f"== 启动后端：{sys.executable} -m backend.main（PET_DATA_DIR={env['PET_DATA_DIR']}）==")

    proc = subprocess.Popen(
        [sys.executable, "-m", "backend.main"],
        cwd=str(PROJECT_ROOT),
        env=env,
        stdout=subprocess.PIPE,
        text=True,
        bufsize=1,
    )
    assert proc.stdout is not None

    lines: queue.Queue[str | None] = queue.Queue()

    def _pump() -> None:
        for line in proc.stdout:  # type: ignore[union-attr]
            lines.put(line)
        lines.put(None)

    threading.Thread(target=_pump, daemon=True).start()

    deadline = time.monotonic() + STARTUP_TIMEOUT
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            proc.kill()
            raise TimeoutError(f"等待 {READY_PREFIX.strip()} 握手行超时（{STARTUP_TIMEOUT}s）")
        try:
            line = lines.get(timeout=remaining)
        except queue.Empty:
            continue
        if line is None:
            raise RuntimeError(f"后端进程在握手前退出（returncode={proc.poll()}）")
        line = line.strip()
        if line.startswith(READY_PREFIX):
            return proc, json.loads(line[len(READY_PREFIX) :])
        print(f"[backend stdout] {line}")


def print_event(evt: dict) -> None:
    """格式化打印一条服务端事件。"""
    msg_type = evt["type"]
    data = evt.get("data") or {}
    if msg_type == "token":
        print(f"  token       {data['text']!r}")
    elif msg_type == "emotion":
        print(f"  emotion     {data['emotion']} (intensity={data['intensity']})")
    elif msg_type == "state":
        print(f"  state       {data['state']}")
    elif msg_type == "reply_start":
        print(f"  reply_start message_id={data['message_id']}")
    elif msg_type == "reply_end":
        print(
            f"  reply_end   interrupted={data.get('interrupted', False)} "
            f"full_text={data['full_text']!r}"
        )
    elif msg_type == "hello_ack":
        print(
            f"  hello_ack   ok={data['ok']} session_id={data.get('session_id')} "
            f"server_version={data.get('server_version')} protocol_version={data.get('protocol_version')}"
        )
    elif msg_type == "error":
        print(f"  error       {data['code']}: {data['message']} fatal={data.get('fatal', False)}")
    else:
        print(f"  {msg_type:11s} {json.dumps(data, ensure_ascii=False)}")


def assert_conversation(events: list[dict]) -> None:
    """校验 §7.1 时序与跨片段标签解析结果。"""
    types = [e["type"] for e in events]
    assert types[0] == "state" and events[0]["data"]["state"] == "thinking", "首事件应为 state:thinking"
    assert types[1] == "reply_start", "第二事件应为 reply_start"
    assert types[-2] == "reply_end", "倒数第二事件应为 reply_end"
    assert types[-1] == "state" and events[-1]["data"]["state"] == "idle", "收尾应为 state:idle"

    emotions = [e["data"]["emotion"] for e in events if e["type"] == "emotion"]
    assert emotions == ["happy", "thinking", "neutral"], f"情绪序列异常：{emotions}"

    tokens = "".join(e["data"]["text"] for e in events if e["type"] == "token")
    reply_end = next(e for e in events if e["type"] == "reply_end")
    assert tokens == reply_end["data"]["full_text"], "token 拼接与 full_text 不一致"
    assert "<emo" not in tokens, "输出中出现情绪标签残渣"

    print(
        f"\n[校验] 事件总数={len(events)} 情绪序列={emotions} "
        f"文本长度={len(tokens)}（token 拼接 = full_text，无标签残渣）"
    )


async def run_smoke(port: int, token: str) -> None:
    uri = f"ws://127.0.0.1:{port}/ws"
    print(f"\n== 连接 {uri} ==")
    async with websockets.connect(uri) as ws:
        # 1) hello 鉴权
        print("\n[1] hello 鉴权")
        await ws.send(
            make_msg(
                "hello",
                {"token": token, "protocol_version": PROTOCOL_VERSION, "app_version": "0.1.0"},
            )
        )
        ack = json.loads(await asyncio.wait_for(ws.recv(), RECV_TIMEOUT))
        print_event(ack)
        assert ack["type"] == "hello_ack" and ack["data"]["ok"] is True, "hello 鉴权失败"

        # 2) 心跳
        print("\n[2] 心跳 ping/pong")
        await ws.send(make_msg("ping", {}))
        pong = json.loads(await asyncio.wait_for(ws.recv(), RECV_TIMEOUT))
        print_event(pong)
        assert pong["type"] == "pong", "心跳未收到 pong"

        # 3) 一轮 Echo 对话
        print("\n[3] user_message → 完整事件流")
        await ws.send(make_msg("user_message", {"text": "你好，小豆！"}))
        events: list[dict] = []
        while True:
            evt = json.loads(await asyncio.wait_for(ws.recv(), RECV_TIMEOUT))
            print_event(evt)
            events.append(evt)
            if evt["type"] == "state" and evt["data"]["state"] == "idle":
                break
        assert_conversation(events)

        # 4) 未实现事件兜底
        print("\n[4] 未实现事件（get_config）应回 NOT_IMPLEMENTED")
        await ws.send(make_msg("get_config", {}))
        err = json.loads(await asyncio.wait_for(ws.recv(), RECV_TIMEOUT))
        print_event(err)
        assert err["type"] == "error" and err["data"]["code"] == "NOT_IMPLEMENTED", "兜底响应异常"

    print("\n✔ 冒烟测试通过：握手 / hello 鉴权 / 心跳 / Echo 流水线（跨片段标签解析）/ 未实现兜底")


def main() -> int:
    proc, ready = start_backend()
    try:
        print(f"== 后端就绪：port={ready['port']} pid={ready['pid']} ==")
        assert ready.get("token"), "开发模式 READY 行应携带 token"
        asyncio.run(run_smoke(port=int(ready["port"]), token=str(ready["token"])))
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
        print("== 后端进程已退出 ==")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
