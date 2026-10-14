"""WS 冒烟测试：真实跑通全链路（真 LLM 版）。

流程：拉起后端子进程 → 逐行解析 stdout 的 PET_READY 握手行 → WS 连接 →
hello 鉴权 → ping/pong 心跳 → 三轮真实对话（第 3 轮验证多轮记忆）→
未实现事件兜底 → 退出清理。

校验点：
- §7.1 时序：state:thinking → reply_start → token/emotion → reply_end → state:idle；
- 流式回复非空；token 拼接 == full_text；无 ``<emo:`` 标签残渣；
- emotion 事件存在且取值在 v1 集合内（模型不输出标签时后端补默认 neutral）；
- 对话中无 error 事件；
- 多轮记忆：第 1 轮告诉它的名字/喜好，第 3 轮能被正确接上。

前置：已配置 LLM key（shared.secrets 读取链：env > keyring > 600 文件）
且 config.toml 的 base_url 可达。

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
RECV_TIMEOUT = 120.0  # 事件间超时：推理型模型思考期间可能较久无输出
PROTOCOL_VERSION = 1

# v1 情绪集合（设计文档 §3.3）
EMOTION_VALUES = {"neutral", "happy", "sad", "angry", "surprised", "shy", "thinking", "sleepy"}


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


def assert_turn(events: list[dict], *, name: str) -> str:
    """校验一轮对话的 §7.1 时序 / 标签剥离 / 情绪合法性；返回拼接后的正文。"""
    types = [e["type"] for e in events]
    assert types[0] == "state" and events[0]["data"]["state"] == "thinking", (
        f"[{name}] 首事件应为 state:thinking，实际：{types[:2]}"
    )
    assert types[1] == "reply_start", f"[{name}] 第二事件应为 reply_start"
    assert "error" not in types, (
        f"[{name}] 对话出现 error 事件：" +
        str([e["data"] for e in events if e["type"] == "error"])
    )
    assert types[-2] == "reply_end", f"[{name}] 倒数第二事件应为 reply_end，实际：{types[-3:]}"
    assert types[-1] == "state" and events[-1]["data"]["state"] == "idle", f"[{name}] 收尾应为 state:idle"
    assert set(types[2:-2]) <= {"token", "emotion"}, f"[{name}] 流式阶段出现意外事件：{types[2:-2]}"

    tokens = "".join(e["data"]["text"] for e in events if e["type"] == "token")
    reply_end = next(e for e in events if e["type"] == "reply_end")
    assert tokens == reply_end["data"]["full_text"], f"[{name}] token 拼接与 full_text 不一致"
    assert tokens.strip(), f"[{name}] 回复为空（推理型模型注意 max_tokens 是否足够）"
    assert "<emo" not in tokens, f"[{name}] 输出中出现情绪标签残渣"

    emotions = [e["data"]["emotion"] for e in events if e["type"] == "emotion"]
    assert emotions, f"[{name}] 没有任何 emotion 事件（后端应至少补默认 neutral）"
    assert set(emotions) <= EMOTION_VALUES, f"[{name}] 情绪取值越界：{emotions}"

    print(
        f"\n[校验-{name}] 事件数={len(events)} 情绪序列={emotions} "
        f"文本长度={len(tokens)}（token 拼接 == full_text，无标签残渣）"
    )
    return tokens


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

        async def one_turn(text: str, *, name: str) -> str:
            print(f"\n[对话-{name}] 用户：{text}")
            await ws.send(make_msg("user_message", {"text": text}))
            events: list[dict] = []
            while True:
                evt = json.loads(await asyncio.wait_for(ws.recv(), RECV_TIMEOUT))
                print_event(evt)
                events.append(evt)
                if evt["type"] == "state" and evt["data"]["state"] == "idle":
                    break
            return assert_turn(events, name=name)

        # 3) 第一轮：问名字（任务书指定的冒烟问句）
        text1 = await one_turn("你好，你叫什么名字", name="第一轮")
        assert "小豆" in text1 or "豆" in text1, f"回复里没提到名字：{text1!r}"

        # 4) 第二轮：告知个人信息（多轮记忆前置）
        await one_turn("我叫张三，我最喜欢喝拿铁咖啡，请记住哦。", name="第二轮")

        # 5) 第三轮：验证多轮记忆接通
        text3 = await one_turn("我叫什么名字？我最喜欢喝什么？", name="第三轮")
        assert "张三" in text3, f"多轮记忆未接通（未答出名字）：{text3!r}"
        assert ("拿铁" in text3 or "咖啡" in text3), f"多轮记忆未接通（未答出喜好）：{text3!r}"

        # 6) 未实现事件兜底
        print("\n[6] 未实现事件（get_config）应回 NOT_IMPLEMENTED")
        await ws.send(make_msg("get_config", {}))
        err = json.loads(await asyncio.wait_for(ws.recv(), RECV_TIMEOUT))
        print_event(err)
        assert err["type"] == "error" and err["data"]["code"] == "NOT_IMPLEMENTED", "兜底响应异常"

    print("\n✔ 冒烟测试通过：握手 / hello 鉴权 / 心跳 / 真实 LLM 三轮对话（时序 / 标签剥离 / 情绪 / 多轮记忆）/ 未实现兜底")


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
