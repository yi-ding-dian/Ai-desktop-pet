"""语音链路真实冒烟（P2 步骤 1 验收脚本）。

分两段，均可独立失败定位问题：

[A] TTS provider 直连：真实 Edge TTS 合成一句 → 校验字节量与 mp3 头；
[B] 全链路：拉起真实后端（真 LLM + 真 Edge TTS，temp PET_DATA_DIR 启用默认语音配置）
    → WS hello 鉴权 → 发一句话 → 收集事件与**二进制音频帧**直到 state:idle →
    逐帧校验（§3.5 头长/JSON/字段/seq/final/mp3 头/大小）→ 音频落盘供人工试听。

校验点（§3.5 / §7.1）：
- 收到 ≥1 个二进制帧；一句话一帧（帧数 == sentence 数）；
- 帧结构：[4字节大端头长][JSON头][mp3 数据]，头字段 type/message_id/seq/format/sample_rate/final；
- seq 从 0 连续；final 恰一个且在最后一帧；
- 音频帧全部先于 reply_end；对话无（非预期）error 事件；
- mp3 头为 ID3v2 或 MPEG 帧同步（0xFFEx）。

前置：LLM key 已配置（keyring / PET_LLM_KEY，同 ws_smoke）；Edge TTS 端点可达。

用法（项目根目录）：
    backend/.venv/bin/python backend/examples/voice_smoke.py
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

if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from backend.interfaces.ws.protocol import unpack_audio_frame  # noqa: E402


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


def check_mp3_header(data: bytes) -> str:
    """校验 mp3 头，返回描述字符串。"""
    if data[:3] == b"ID3":
        return "ID3v2"
    if len(data) >= 2 and data[0] == 0xFF and (data[1] & 0xE0) == 0xE0:
        return f"MPEG 帧同步 0x{data[0]:02x}{data[1]:02x}"
    raise AssertionError(f"mp3 头不正确：{data[:4].hex(' ')}")


# ---------------------------------------------------------------- [A] provider 直连


async def smoke_provider(save_dir: Path) -> None:
    from backend.modules.voice.tts.edge import EdgeTTSProvider

    print("\n[A] Edge TTS provider 直连冒烟")
    provider = EdgeTTSProvider(voice="zh-CN-XiaoxiaoNeural")
    text = "你好呀，我是小兔。"
    t0 = time.monotonic()
    audio = await provider.synthesize(text)
    cost = time.monotonic() - t0

    header_desc = check_mp3_header(audio)
    assert len(audio) > 1024, f"音频过小：{len(audio)} 字节"
    out = save_dir / "tts_direct.mp3"
    out.write_bytes(audio)
    print(
        f"  ✔ 合成成功：text={text!r}\n"
        f"    字节数={len(audio)} 耗时={cost:.2f}s mp3头={header_desc} 前4字节={audio[:4].hex(' ')}\n"
        f"    已保存：{out}"
    )


# ---------------------------------------------------------------- [B] 全链路


def start_backend() -> tuple[subprocess.Popen[str], dict, str]:
    """拉起后端子进程并解析 READY 握手行，返回 (进程, READY 负载, 数据目录)。"""
    env = dict(os.environ)
    env.pop("PET_TOKEN", None)  # 强制开发模式（READY 行携带 token）
    data_dir = tempfile.mkdtemp(prefix="pet-voice-smoke-")
    env["PET_DATA_DIR"] = data_dir  # 全新目录 → 默认模板（[voice].enabled=true）
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
            return proc, json.loads(line[len(READY_PREFIX) :]), data_dir
        print(f"[backend stdout] {line}")


def print_event(evt: dict) -> None:
    """打印一条服务端事件（token 逐片太多，只累计不逐条打印）。"""
    msg_type = evt["type"]
    data = evt.get("data") or {}
    if msg_type == "token":
        return
    if msg_type == "sentence":
        print(f"  sentence    #{data['index']} {data['text']!r}")
    elif msg_type == "emotion":
        print(f"  emotion     {data['emotion']}")
    elif msg_type in {"state", "reply_start", "reply_end", "hello_ack", "error", "pong"}:
        if msg_type == "reply_end":
            print(
                f"  reply_end   interrupted={data.get('interrupted', False)} "
                f"full_text={data['full_text']!r}"
            )
        elif msg_type == "state":
            print(f"  state       {data['state']}")
        else:
            print(f"  {msg_type:11s} {json.dumps(data, ensure_ascii=False)[:160]}")
    else:
        print(f"  {msg_type:11s} {json.dumps(data, ensure_ascii=False)[:160]}")


async def run_full_chain(port: int, token: str, save_dir: Path, user_text: str) -> None:
    uri = f"ws://127.0.0.1:{port}/ws"
    print(f"\n[B] 全链路冒烟（真 LLM + 真 TTS）→ {uri}")

    async with websockets.connect(uri) as ws:
        await ws.send(
            make_msg(
                "hello",
                {"token": token, "protocol_version": PROTOCOL_VERSION, "app_version": "0.1.0"},
            )
        )
        ack = json.loads(await asyncio.wait_for(ws.recv(), RECV_TIMEOUT))
        print_event(ack)
        assert ack["type"] == "hello_ack" and ack["data"]["ok"] is True, "hello 鉴权失败"

        print(f"\n[对话] 用户：{user_text}")
        t_sent = time.monotonic()
        await ws.send(make_msg("user_message", {"text": user_text}))

        events: list[dict] = []
        frames: list[tuple[dict, bytes]] = []
        timeline: list[str] = []
        first_frame_cost: float | None = None

        while True:
            raw = await asyncio.wait_for(ws.recv(), RECV_TIMEOUT)

            if isinstance(raw, bytes):
                header, payload = unpack_audio_frame(raw)
                frames.append((header, payload))
                timeline.append("frame")
                if first_frame_cost is None:
                    first_frame_cost = time.monotonic() - t_sent
                head = check_mp3_header(payload)
                print(
                    f"  audio帧     seq={header['seq']} final={header['final']} "
                    f"{len(payload)} 字节 mp3头={head} 前4字节={payload[:4].hex(' ')}"
                )
                continue

            evt = json.loads(raw)
            events.append(evt)
            timeline.append(f"event:{evt['type']}")
            print_event(evt)
            if evt["type"] == "state" and evt["data"]["state"] == "idle":
                break

        # ---------- 校验 ----------
        print("\n[B-校验] 帧与事件")
        errors = [e for e in events if e["type"] == "error"]
        for err in errors:
            print(f"  error: {err['data']['code']}: {err['data']['message']}")
        assert not errors, "对话出现 error 事件"

        sentences = [e for e in events if e["type"] == "sentence"]
        assert frames, "未收到任何二进制音频帧（断言失败）"
        assert len(frames) == len(sentences), (
            f"一句话一帧：帧数 {len(frames)} != sentence 数 {len(sentences)}"
        )

        reply_start = next(e for e in events if e["type"] == "reply_start")
        total_bytes = 0
        for header, payload in frames:
            assert header["type"] == "audio"
            assert header["format"] == "mp3"
            assert header["sample_rate"] == 24000
            assert header["message_id"] == reply_start["data"]["message_id"]
            assert len(payload) > 512, f"音频帧过小：{len(payload)}"
            check_mp3_header(payload)
            total_bytes += len(payload)

        seqs = [h["seq"] for h, _ in frames]
        assert seqs == list(range(len(frames))), f"seq 不连续：{seqs}"
        finals = [h["final"] for h, _ in frames]
        assert finals.count(True) == 1 and finals[-1] is True, f"final 标记异常：{finals}"

        last_frame_at = max(i for i, item in enumerate(timeline) if item == "frame")
        assert timeline.index("event:reply_end") > last_frame_at, "音频帧晚于 reply_end"
        assert timeline[-1] == "event:state", "收尾事件不是 state:idle"

        tokens = "".join(e["data"]["text"] for e in events if e["type"] == "token")
        # 断句会规范化空白（切句时 strip 换行/空格），比较时忽略空白字符
        strip_ws = lambda s: "".join(s.split())  # noqa: E731
        assert strip_ws("".join(e["data"]["text"] for e in sentences)) == strip_ws(tokens), (
            "断句丢文本"
        )

        # ---------- 落盘与摘要 ----------
        combined = save_dir / "reply_combined.mp3"
        combined.write_bytes(b"".join(p for _, p in frames))
        first = save_dir / "reply_frame0.mp3"
        first.write_bytes(frames[0][1])

        sizes = [len(p) for _, p in frames]
        print(
            f"\n[B-摘要]\n"
            f"  sentence 数={len(sentences)}  音频帧数={len(frames)}  总字节={total_bytes}\n"
            f"  每帧字节={sizes}\n"
            f"  seq={seqs}  final={finals}\n"
            f"  首帧时延（用户消息→首帧）={first_frame_cost:.2f}s\n"
            f"  文本长度={len(tokens)} 回复={tokens!r}\n"
            f"  音频已保存：{first}\n"
            f"              {combined}（按序拼接，可直接播放）"
        )


def main() -> int:
    save_dir = Path(tempfile.mkdtemp(prefix="pet-voice-out-"))
    print(f"== 输出目录：{save_dir} ==")

    # [A] provider 直连（不依赖 LLM）
    asyncio.run(smoke_provider(save_dir))

    # [B] 全链路
    proc, ready, data_dir = start_backend()
    try:
        print(f"== 后端就绪：port={ready['port']} pid={ready['pid']} ==")
        assert ready.get("token"), "开发模式 READY 行应携带 token"
        asyncio.run(
            run_full_chain(
                port=int(ready["port"]),
                token=str(ready["token"]),
                save_dir=save_dir,
                user_text="你好呀，请用两三句话介绍一下你自己吧。",
            )
        )
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
        print(f"== 后端进程已退出（数据目录：{data_dir}）==")

    print("\n✔ 语音链路冒烟通过：provider 直连 / hello / 全链路对话 / ≥1 二进制帧 / 帧格式 / mp3 / final")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
