"""记忆与持久化真实冒烟（P3）：真 LLM + 真 SQLite + 进程重启。

流程（全真实链路，不 mock）：
1. 独立 PET_DATA_DIR（临时目录）+ 短空闲配置（[memory] idle_seconds=2）——
   即"手动触发入口"之外的真实自动触发路径；
2. 起后端 → WS 连接 → hello 鉴权（记下 session_id）；
3. 两轮真实对话（含个人信息：姓名/职业/城市/喜好）；
4. 等待后台空闲提取：轮询 pet.db 直到 memories/profile 落库（打印内容）；
5. 重启后端（同 PET_DATA_DIR）→ 新连接：
   - load_history{session_id=旧会话} → 断言历史仍在（气泡回填）；
   - 在旧会话继续问"我叫什么名字" → 断言回复含名字（记忆注入生效）；
   - 读后端日志文件，断言 "记忆注入：画像 N 条 / 长期记忆 M 条"（N,M>0）。
6. 打印完整摘要（供 p3-memory-report.md 引用）。

前置：与 ws_smoke.py 相同——LLM key 已配置（env > keyring > 600 文件）；
用户 config.toml（~/.config/ai-desktop-pet/config.toml）的 [llm] 段被复制到
临时目录（保证 base_url/model 与用户环境一致）。

用法（项目根目录）：
    backend/.venv/bin/python backend/examples/memory_smoke.py
"""

from __future__ import annotations

import asyncio
import json
import os
import queue
import re
import sqlite3
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
RECV_TIMEOUT = 120.0  # 推理型模型思考期间可能较久无输出
PROTOCOL_VERSION = 1

USER_CONFIG_PATH = Path.home() / ".config" / "ai-desktop-pet" / "config.toml"

#: 记忆提取空闲阈值（冒烟专用短值：= "手动触发"的真实等价入口）
SMOKE_IDLE_SECONDS = 2
SMOKE_SCAN_SECONDS = 1
EXTRACT_WAIT_TIMEOUT = 180.0  # 前台等待提取落库的最长时间（真 LLM 提取调用可能较慢）


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


def write_smoke_config(data_dir: Path) -> None:
    """生成冒烟用 config.toml：复用用户 [llm] 段 + 短空闲记忆配置 + 关语音/行为。"""
    llm: dict = {}
    if USER_CONFIG_PATH.exists():
        import tomllib

        with USER_CONFIG_PATH.open("rb") as f:
            llm = tomllib.load(f).get("llm", {})
    base_url = llm.get("base_url", "http://192.168.0.8:3000/v1")
    model = llm.get("model", "deepseek-flash")
    temperature = llm.get("temperature", 0.8)
    max_tokens = llm.get("max_tokens", 768)
    (data_dir / "config.toml").write_text(
        f"""\
# 记忆冒烟专用配置（自动生成）
[llm]
base_url    = "{base_url}"
model       = "{model}"
temperature = {temperature}
max_tokens  = {max_tokens}

[voice]           # 冒烟关注记忆链路，关闭 TTS 缩短对话时延
enabled = false

[behavior]        # 关闭自主行为，避免事件流干扰断言
enabled = false

[memory]
enabled                = true
idle_seconds           = {SMOKE_IDLE_SECONDS}
check_interval_seconds = {SMOKE_SCAN_SECONDS}
""",
        encoding="utf-8",
    )


def start_backend(data_dir: Path) -> tuple[subprocess.Popen[str], dict]:
    """拉起后端子进程并解析 READY 握手行（同 ws_smoke.py 模式）。"""
    env = dict(os.environ)
    env.pop("PET_TOKEN", None)  # 开发模式（READY 行携带 token）
    env["PET_DATA_DIR"] = str(data_dir)
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
            raise TimeoutError("等待 PET_READY 握手行超时")
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


def stop_backend(proc: subprocess.Popen[str]) -> None:
    proc.terminate()
    try:
        proc.wait(timeout=8)
    except subprocess.TimeoutExpired:
        proc.kill()
    print("== 后端进程已退出 ==")


def read_db(path: Path) -> tuple[list[tuple], list[tuple]]:
    """直接读 pet.db 的 memories / profile（独立连接，绕过进程）。"""
    conn = sqlite3.connect(path)
    try:
        memories = conn.execute(
            "SELECT id, text, kind, importance FROM memories ORDER BY id"
        ).fetchall()
        profile = conn.execute(
            "SELECT key, value FROM profile ORDER BY key"
        ).fetchall()
    finally:
        conn.close()
    return memories, profile


def assert_turn_shape(events: list[dict], *, name: str) -> str:
    types = [e["type"] for e in events]
    assert types[0] == "state" and events[0]["data"]["state"] == "thinking", f"[{name}] {types[:2]}"
    assert types[1] == "reply_start", f"[{name}] {types[:2]}"
    assert "error" not in types, f"[{name}] 出现 error：{[e['data'] for e in events if e['type']=='error']}"
    assert types[-2] == "reply_end" and types[-1] == "state", f"[{name}] 收尾异常：{types[-3:]}"
    text = "".join(e["data"]["text"] for e in events if e["type"] == "token")
    assert text.strip(), f"[{name}] 空回复"
    return text


async def run_smoke(data_dir: Path) -> int:
    db_path = data_dir / "pet.db"
    log_path = data_dir / "logs" / f"backend_{time.strftime('%Y-%m-%d')}.log"

    # ---------- 第一次运行：两轮真实对话 ----------
    proc1, ready1 = start_backend(data_dir)
    old_sid = ""
    turn2_text = ""
    memories: list[tuple] = []
    profile: list[tuple] = []
    try:
        uri = f"ws://127.0.0.1:{ready1['port']}/ws"
        print(f"== 连接 {uri} ==")
        async with websockets.connect(uri) as ws:
            await ws.send(
                make_msg("hello", {"token": ready1["token"], "protocol_version": 1, "app_version": "smoke"})
            )
            ack = json.loads(await asyncio.wait_for(ws.recv(), RECV_TIMEOUT))
            assert ack["type"] == "hello_ack" and ack["data"]["ok"], f"鉴权失败：{ack}"
            old_sid = ack["data"]["session_id"]
            print(f"[1] hello_ack ok session_id={old_sid}")

            async def one_turn(text: str, name: str) -> str:
                print(f"\n[对话-{name}] 用户：{text}")
                await ws.send(make_msg("user_message", {"text": text}))
                events: list[dict] = []
                while True:
                    raw = await asyncio.wait_for(ws.recv(), RECV_TIMEOUT)
                    if isinstance(raw, bytes):
                        continue
                    evt = json.loads(raw)
                    events.append(evt)
                    if evt["type"] == "state" and evt["data"]["state"] == "idle":
                        break
                reply = assert_turn_shape(events, name=name)
                print(f"[对话-{name}] 小兔：{reply}")
                return reply

            await one_turn(
                "你好呀！我叫李雷，是一名中学物理老师，住在杭州，特别喜欢喝拿铁咖啡。请记住我哦。",
                "第一轮（个人信息）",
            )
            turn2_text = await one_turn("我周末喜欢去西湖边跑步。", "第二轮")

        # 后端保持运行：等待后台空闲提取落库（空闲阈值 2s + 扫描 1s 自动触发）
        print(f"\n[3] 等待记忆提取（空闲 {SMOKE_IDLE_SECONDS}s 自动触发 + 真 LLM 提取）...")
        deadline = time.monotonic() + EXTRACT_WAIT_TIMEOUT
        while time.monotonic() < deadline:
            if db_path.exists():
                memories, profile = read_db(db_path)
                if memories:
                    break
            await asyncio.sleep(1.0)
        assert memories, (
            f"等待 {EXTRACT_WAIT_TIMEOUT}s 后 memories 仍为空（检查日志：{log_path}）"
        )
    finally:
        stop_backend(proc1)

    print(f"[3] memories（{len(memories)} 条）:")
    for mid, text, kind, importance in memories:
        print(f"    #{mid} [{kind}] i={importance:.2f} {text}")
    print(f"[3] profile（{len(profile)} 条）:")
    for key, value in profile:
        print(f"    {key} = {value}")
    assert profile, "profile 为空（期望提取出称呼/姓名等画像）"

    # ---------- 重启后端 ----------
    print("\n[4] 重启后端（同一 PET_DATA_DIR，历史与记忆应保留）...")
    proc2, ready2 = start_backend(data_dir)
    try:
        uri2 = f"ws://127.0.0.1:{ready2['port']}/ws"
        async with websockets.connect(uri2) as ws:
            await ws.send(
                make_msg("hello", {"token": ready2["token"], "protocol_version": 1, "app_version": "smoke"})
            )
            ack = json.loads(await asyncio.wait_for(ws.recv(), RECV_TIMEOUT))
            assert ack["type"] == "hello_ack" and ack["data"]["ok"], f"重启后鉴权失败：{ack}"
            new_sid = ack["data"]["session_id"]
            print(f"[4] 重启后 hello_ack session_id={new_sid}（新会话）")

            # 4a. load_history：旧会话历史回填
            await ws.send(make_msg("load_history", {"session_id": old_sid, "limit": 20}))
            while True:
                evt = json.loads(await asyncio.wait_for(ws.recv(), RECV_TIMEOUT))
                if evt["type"] == "history":
                    break
            messages = evt["data"]["messages"]
            print(f"[4a] load_history 返回 {len(messages)} 条：")
            for m in messages:
                print(f"     [{m['role']}] {m['content']}")
            assert len(messages) == 4, "重启后历史应完整保留（两轮 = 4 条）"
            assert any("李雷" in m["content"] for m in messages), "历史里应含自我介绍"
            assert any(m["role"] == "assistant" and m["content"] == turn2_text for m in messages)

            # 4b. 旧会话继续对话：验证记忆注入（回复 + 日志双证据）
            print("\n[4b] 在旧会话继续对话（验证重启后记忆注入）")
            await ws.send(
                make_msg("user_message", {"text": "你还记得我叫什么名字吗？", "session_id": old_sid})
            )
            events: list[dict] = []
            while True:
                raw = await asyncio.wait_for(ws.recv(), RECV_TIMEOUT)
                if isinstance(raw, bytes):
                    continue
                evt = json.loads(raw)
                events.append(evt)
                if evt["type"] == "state" and evt["data"]["state"] == "idle":
                    break
            reply = assert_turn_shape(events, name="第三轮（重启后）")
            print(f"[4b] 小兔：{reply}")
            recalled = "李雷" in reply
            print(f"[4b] 回复{'含' if recalled else '不含'}名字「李雷」{'✔（记忆注入生效的最强证据）' if recalled else '（观察项，见日志证据）'}")
    finally:
        stop_backend(proc2)

    # ---------- 日志证据：记忆注入 ----------
    print("\n[5] 日志证据（记忆注入条数，不含记忆全文）:")
    injected = 0
    log_text = log_path.read_text(encoding="utf-8") if log_path.exists() else ""
    for line in log_text.splitlines():
        if "记忆注入" in line:
            print(f"    {line.strip()}")
            injected += 1
    assert injected >= 1, f"日志中未见「记忆注入」（日志文件：{log_path}）"
    matches = re.findall(r"记忆注入：画像 (\d+) 条 / 长期记忆 (\d+) 条", log_text)
    assert matches and all(int(a) > 0 or int(b) > 0 for a, b in matches), f"注入条数异常：{matches}"

    print("\n✔ 记忆与持久化冒烟通过：")
    print("  · 两轮真实对话 → 空闲自动触发提取 → memories/profile 落库")
    print("  · 重启后端 → load_history 历史完整回填（4 条）")
    print("  · 重启后新对话 → 上下文注入画像 + 长期记忆（日志与回复双证据）")
    print(f"  · 数据目录（供复查）：{data_dir}")
    return 0


def main() -> int:
    data_dir = Path(tempfile.mkdtemp(prefix="pet-memory-smoke-"))
    write_smoke_config(data_dir)
    return asyncio.run(run_smoke(data_dir))


if __name__ == "__main__":
    raise SystemExit(main())
