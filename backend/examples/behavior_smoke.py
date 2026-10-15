"""行为引擎冒烟脚本：真后端 + 脚本模拟客户端（P3 §4.5 / §7.4 集成实测）。

流程（验证"后端决策、前端执行"闭环）：
1. 拉起后端子进程（临时 PET_DATA_DIR，预写 config.toml 把 [behavior] 空闲间隔调短）；
2. WS 连接 → hello 鉴权；
3. env_update 上报（几何 + system_idle_seconds + pet_state=idle）；
4. 等引擎**自动下发** behavior 指令（打印 name/params）；
5. 回 behavior_done{interrupted:false}（模拟前端执行完成）；
6. 等第二条 behavior（证明：收到 done 后引擎继续下一轮）；
7. 回 behavior_done{interrupted:true} 模拟用户打断；
8. pet_event tap_head → 应收到轻量 emotion 回应（mood 上升的后端侧表现）；
9. 退出清理。

期望的引擎日志（子进程 stdout 会透传打印）：
    下发行为 b_xxx walk params={...} → 行为 b_xxx（walk）结束：interrupted=False → 行为 xx 记账 ...

用法（项目根目录）：
    backend/.venv/bin/python backend/examples/behavior_smoke.py
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
EVENT_TIMEOUT = 15.0  # 等 behavior 下发（idle 间隔已调短，宽松兜底）
PROTOCOL_VERSION = 1

#: 冒烟用短空闲间隔配置（写进临时 PET_DATA_DIR 的 config.toml；其余配置取默认值）
SMOKE_CONFIG = """\
[voice]
enabled = false

[behavior]
idle_min_seconds = 1.0
idle_max_seconds = 2.0
"""


def make_msg(msg_type: str, data: dict) -> str:
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
    env.pop("PET_TOKEN", None)  # 开发模式（READY 行携带 token）
    data_dir = tempfile.mkdtemp(prefix="pet-behavior-smoke-")
    env["PET_DATA_DIR"] = data_dir
    (Path(data_dir) / "config.toml").write_text(SMOKE_CONFIG, encoding="utf-8")
    env["PET_LOG_LEVEL"] = "INFO"
    print(f"== 启动后端：{sys.executable} -m backend.main（PET_DATA_DIR={data_dir}）==")

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
        print(f"[backend] {line}")


def print_event(evt: dict) -> None:
    msg_type = evt["type"]
    data = evt.get("data") or {}
    if msg_type == "behavior":
        print(f"  behavior    {data['name']} id={data['id']} params={json.dumps(data['params'], ensure_ascii=False)}")
    elif msg_type == "emotion":
        print(f"  emotion     {data['emotion']} (intensity={data['intensity']})")
    elif msg_type == "state":
        print(f"  state       {data['state']}")
    elif msg_type == "hello_ack":
        print(f"  hello_ack   ok={data['ok']} session_id={data.get('session_id')}")
    elif msg_type == "error":
        print(f"  error       {data['code']}: {data['message']}")
    else:
        print(f"  {msg_type:11s} {json.dumps(data, ensure_ascii=False)}")


async def recv_until(ws, msg_type: str, *, timeout: float = EVENT_TIMEOUT) -> dict:
    """收事件直到出现目标类型（跳过其它事件）。"""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        raw = await asyncio.wait_for(ws.recv(), timeout=max(0.1, deadline - time.monotonic()))
        evt = json.loads(raw)
        print_event(evt)
        if evt["type"] == msg_type:
            return evt
    raise TimeoutError(f"等待 {msg_type} 事件超时（{timeout}s）")


async def run_smoke(port: int, token: str) -> None:
    uri = f"ws://127.0.0.1:{port}/ws"
    print(f"\n== 连接 {uri} ==")
    async with websockets.connect(uri) as ws:
        # 1) hello 鉴权
        print("\n[1] hello 鉴权")
        await ws.send(
            make_msg(
                "hello",
                {"token": token, "protocol_version": PROTOCOL_VERSION, "app_version": "smoke"},
            )
        )
        ack = await recv_until(ws, "hello_ack")
        assert ack["data"]["ok"] is True, "hello 鉴权失败"

        # 2) env_update：几何 + 系统空闲 + 宠物状态（引擎决策输入）
        print("\n[2] env_update 上报（几何 / idle=5s / pet_state=idle）")
        await ws.send(
            make_msg(
                "env_update",
                {
                    "work_area": {"x": 0, "y": 0, "width": 1920, "height": 1080},
                    "window_pos": {"x": 760, "y": 630},
                    "window_size": {"width": 400, "height": 400},
                    "system_idle_seconds": 5.0,
                    "pet_state": "idle",
                },
            )
        )

        # 3) 等引擎自动下发第一条 behavior
        print("\n[3] 等引擎下发 behavior（空闲计时 1–2s + 掷骰）")
        first = await recv_until(ws, "behavior")
        assert first["data"]["name"] in {"walk", "look_around", "nap", "sleep"}
        assert "duration_ms" in first["data"]["params"], "行为参数应含 duration_ms"
        if first["data"]["name"] == "walk":
            assert first["data"]["params"]["direction"] in {"left", "right"}

        # 4) 模拟前端执行完成 → 回报（interrupted:false）
        print(f"\n[4] 回报 behavior_done（{first['data']['id']} 完成）")
        await ws.send(
            make_msg(
                "behavior_done", {"id": first["data"]["id"], "interrupted": False}
            )
        )

        # 5) 再等一条：证明收到 done 后引擎记账并继续下一轮
        print("\n[5] 等第二条 behavior（验证 done 后引擎继续）")
        second = await recv_until(ws, "behavior")
        assert second["data"]["id"] != first["data"]["id"]

        # 6) 模拟用户打断（interrupted:true）
        print(f"\n[6] 回报 behavior_done（{second['data']['id']} 被打断）")
        await ws.send(
            make_msg("behavior_done", {"id": second["data"]["id"], "interrupted": True})
        )

        # 7) 摸头 → 轻量情绪回应（v1：不调 LLM）
        print("\n[7] pet_event tap_head → 等 emotion 回应")
        await ws.send(make_msg("pet_event", {"kind": "tap_head", "payload": {}}))
        emotion = await recv_until(ws, "emotion")
        assert emotion["data"]["emotion"] == "happy"

    print("\n✔ 行为引擎冒烟通过：下发 → done → 继续 → 打断 → 摸头回应 全链路成立")


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
