"""behavior 模块单测 + WS 集成（设计文档 §4.5 主循环 / §7.4 时序）。

覆盖：
- 权重掷骰（前置过滤 / 全零兜底 / 权重分布）；
- 情境调制（时段 / 精力 / 心情 / 用户离开与回来 / 免打扰）；
- mood / energy 软状态；
- 引擎：下发 → 等 done → 记账；指令超时兜底；连接断开清理；用户回来唤醒；
- dispatcher 路由：pet_event（tap_head → mood↑ + 轻量 emotion）/ env_update / behavior_done。
"""

from __future__ import annotations

import asyncio
import json
import random
import time
import uuid
from datetime import datetime
from typing import Any

import pytest
import uvicorn
import websockets

from backend.application.chat_pipeline import ChatPipeline
from backend.application.session import SessionManager
from backend.interfaces.ws.dispatcher import _ConnectionSink, build_dispatcher
from backend.interfaces.ws.protocol import EnvUpdateData
from backend.interfaces.ws.server import create_app
from backend.modules.behavior import rules
from backend.modules.behavior.behaviors import (
    BEHAVIORS,
    BehaviorContext,
    BehaviorSpec,
    choose_behavior,
    fit_walk_to_screen,
)
from backend.modules.behavior.engine import (
    DONE_TIMEOUT_BUFFER_SECONDS,
    BehaviorEngine,
)
from backend.modules.behavior.mood import MoodState
from backend.shared.config import BehaviorConfig
from fakes import EchoLLMProvider

TOKEN = "test-behavior-token"
RECV_TIMEOUT = 8.0


# ---------------------------------------------------------------- 替身 / 工具


class FakeSink:
    """BehaviorSink 替身：记录下行事件；closed 可控。"""

    def __init__(self) -> None:
        self.sent: list[tuple[str, dict[str, Any]]] = []
        self.closed = False

    async def send_event(
        self, msg_type: str, data: Any = None, *, reply_to: str | None = None
    ) -> bool:
        if self.closed:
            return False
        self.sent.append((msg_type, dict(data or {})))
        return True

    def is_closed(self) -> bool:
        return self.closed


async def wait_for_event(
    sink: FakeSink,
    msg_type: str,
    *,
    timeout: float = 2.0,
    predicate: Any = None,
) -> dict[str, Any]:
    """等待（FakeSink 记录中出现）某类型事件；超时抛 AssertionError。"""
    deadline = time.monotonic() + timeout
    index = 0
    while time.monotonic() < deadline:
        while index < len(sink.sent):
            typ, data = sink.sent[index]
            index += 1
            if typ == msg_type and (predicate is None or predicate(data)):
                return data
        await asyncio.sleep(0.01)
    raise AssertionError(f"等待事件 {msg_type} 超时（已收到：{[t for t, _ in sink.sent]}）")


def make_ctx(
    *,
    now: datetime | None = None,
    energy: float = 0.8,
    mood: float = 0.6,
    idle: float | None = None,
    pet_state: str | None = None,
    **geo: Any,
) -> BehaviorContext:
    return BehaviorContext(
        now=now or datetime(2026, 10, 14, 12, 0, 0),
        mood=mood,
        energy=energy,
        system_idle_seconds=idle,
        pet_state=pet_state,
        work_area=geo.get("work_area"),
        window_pos=geo.get("window_pos"),
        window_size=geo.get("window_size"),
    )


def tiny_spec(
    name: str = "walk",
    *,
    base_weight: float = 1.0,
    max_duration_ms: int = 80,
    cooldown: float = 0.02,
    energy_delta: float = -0.02,
) -> BehaviorSpec:
    """测试用小行为：时长/冷却很短（引擎超时兜底 = max 时长 + 5s buffer，测试单独收窄）。"""
    return BehaviorSpec(
        name=name,
        base_weight=base_weight,
        min_duration_ms=20,
        max_duration_ms=max_duration_ms,
        cooldown_seconds=cooldown,
        energy_delta=energy_delta,
        precondition=lambda _ctx: True,
        make_params=lambda _ctx, _rng: {
            "direction": "right",
            "distance": 100,
            "duration_ms": max_duration_ms,
        },
    )


# ---------------------------------------------------------------- mood


def test_mood_interactions_and_clamp() -> None:
    mood = MoodState(mood=0.6, energy=0.8)

    mood.on_pet_tapped()
    assert mood.mood > 0.6 and mood.energy > 0.8

    before = mood.mood
    mood.on_conversation()
    assert mood.mood > before

    mood.apply_energy_delta(-0.5)
    # 0.8（初始）+0.03（摸头）-0.02（对话） = 0.81 → -0.5
    assert mood.energy == pytest.approx(0.81 - 0.5)
    mood.apply_energy_delta(-10.0)
    assert mood.energy == 0.0  # 下限截断
    mood.apply_energy_delta(10.0)
    assert mood.energy == 1.0  # 上限截断


def test_mood_idle_decay_starts_after_threshold() -> None:
    now = 1_000_000.0
    mood = MoodState(mood=0.9)
    mood.last_interaction_ts = now

    # 30 分钟内：不衰减
    assert mood.apply_idle_decay(now + 29 * 60) == 0.0
    # 超过阈值：从上次结算点开始按分钟衰减
    decay = mood.apply_idle_decay(now + 31 * 60)
    assert decay > 0
    assert mood.mood < 0.9
    # 下限钳制：长时间无互动不蔫到底
    for step in range(1, 200):
        mood.apply_idle_decay(now + 31 * 60 + step * 60)
    assert mood.mood == pytest.approx(0.2)


# ---------------------------------------------------------------- rules


def test_time_bucket() -> None:
    assert rules.time_bucket(datetime(2026, 10, 14, 10, 0)) == "day"
    assert rules.time_bucket(datetime(2026, 10, 14, 20, 0)) == "evening"
    assert rules.time_bucket(datetime(2026, 10, 14, 2, 0)) == "night"
    assert rules.time_bucket(datetime(2026, 10, 14, 23, 30)) == "night"


def test_quiet_hours_parsing_and_match() -> None:
    # 非法格式尽早抛错
    with pytest.raises(ValueError):
        rules.parse_quiet_hours(["bad"])
    with pytest.raises(ValueError):
        rules.parse_quiet_hours(["25:00-26:00"])

    # 空列表 = 无免打扰
    assert rules.in_quiet_hours(datetime(2026, 10, 14, 3, 0), []) is False
    # 跨午夜：23:00-07:00
    assert rules.in_quiet_hours(datetime(2026, 10, 14, 3, 0), ["23:00-07:00"]) is True
    assert rules.in_quiet_hours(datetime(2026, 10, 14, 23, 30), ["23:00-07:00"]) is True
    assert rules.in_quiet_hours(datetime(2026, 10, 14, 12, 0), ["23:00-07:00"]) is False
    # 同日区间：12:30-13:30
    assert rules.in_quiet_hours(datetime(2026, 10, 14, 13, 0), ["12:30-13:30"]) is True
    assert rules.in_quiet_hours(datetime(2026, 10, 14, 12, 0), ["12:30-13:30"]) is False


def test_user_returned_and_engaged() -> None:
    assert rules.user_returned(1000.0, 30.0) is True
    assert rules.user_returned(1000.0, 800.0) is False  # 一直没回来
    assert rules.user_returned(30.0, 10.0) is False  # 一直在用电脑
    assert rules.is_engaged("thinking") is True
    assert rules.is_engaged("speaking") is True
    assert rules.is_engaged("dragging") is True
    assert rules.is_engaged("idle") is False
    assert rules.is_engaged(None) is False


def test_modulation_favors_sleep_at_night_and_low_energy() -> None:
    day = make_ctx(now=datetime(2026, 10, 14, 12, 0), energy=0.8)
    night = make_ctx(now=datetime(2026, 10, 14, 2, 0), energy=0.8)
    # 调制只看权重系数（前置过滤另测），故用全表基础权重做对比基线
    all_weights = {name: spec.base_weight for name, spec in BEHAVIORS.items()}
    rules.modulate(
        day_weights := dict(all_weights),
        now=day.now,
        energy=day.energy,
        mood=day.mood,
        system_idle_seconds=None,
    )
    rules.modulate(
        night_weights := dict(all_weights),
        now=night.now,
        energy=night.energy,
        mood=night.mood,
        system_idle_seconds=None,
    )
    assert night_weights["sleep"] > day_weights["sleep"]
    assert night_weights["walk"] < day_weights["walk"]

    # 精力低 → sleep 权重升高；用户离开 → 更偏睡觉
    low = make_ctx(energy=0.2)
    low_weights = dict(all_weights)
    rules.modulate(
        low_weights, now=low.now, energy=low.energy, mood=low.mood, system_idle_seconds=None
    )
    assert low_weights["sleep"] > day_weights["sleep"]

    away_weights = dict(all_weights)
    rules.apply_system_idle(away_weights, 2000.0)
    assert away_weights["sleep"] > day_weights["sleep"]

    # 用户刚回来 → 偏活跃
    wake_weights = dict(all_weights)
    rules.apply_wake_boost(wake_weights)
    assert wake_weights["walk"] > day_weights["walk"]


# ---------------------------------------------------------------- 掷骰与参数


def test_choose_behavior_filters_by_precondition() -> None:
    ctx = make_ctx()  # 白天、精力高 → sleep/nap 前置不过
    rng = random.Random(1)
    for _ in range(20):
        spec = choose_behavior(ctx, rng)
        assert spec is not None and spec.name in ("walk", "look_around")

    night_ctx = make_ctx(now=datetime(2026, 10, 14, 2, 0), energy=0.2)
    names = {choose_behavior(night_ctx, random.Random(i)).name for i in range(60)}  # type: ignore[union-attr]
    assert "sleep" in names  # 深夜 + 低精力时深睡可选且会出现


def test_choose_behavior_all_zero_weights_returns_none() -> None:
    specs = {"walk": tiny_spec("walk", base_weight=0.0)}
    assert choose_behavior(make_ctx(), random.Random(0), specs) is None


def test_fit_walk_to_screen() -> None:
    # 右侧贴边 → 翻转方向
    ctx = make_ctx(
        work_area={"x": 0, "width": 1920},
        window_pos={"x": 1800},
        window_size={"width": 400},
    )
    direction, distance = fit_walk_to_screen(ctx, "right", 300)
    assert direction == "left" and distance == 300

    # 两侧都不够 → 缩短到最小步长（不低于 40px 的观感下限）
    ctx2 = make_ctx(
        work_area={"x": 0, "width": 420},
        window_pos={"x": 0},
        window_size={"width": 400},
    )
    direction2, distance2 = fit_walk_to_screen(ctx2, "right", 300)
    assert direction2 == "right" and distance2 == 40

    # 几何缺失 → 原样返回
    assert fit_walk_to_screen(make_ctx(), "left", 200) == ("left", 200)


# ---------------------------------------------------------------- 引擎（单测）


def test_engine_dispatch_wait_done_and_loop_continues(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        "backend.modules.behavior.engine.DONE_TIMEOUT_BUFFER_SECONDS", 0.2
    )

    async def scenario() -> None:
        engine = BehaviorEngine(
            BehaviorConfig(idle_min_seconds=0.01, idle_max_seconds=0.02),
            rng=random.Random(7),
            specs={"walk": tiny_spec("walk")},
        )
        sink = FakeSink()
        engine.set_connection(sink)
        engine.start()
        try:
            first = await wait_for_event(sink, "behavior")
            assert first["name"] == "walk" and first["params"]["distance"] == 100
            # 回报完成 → 引擎记账（消耗 -0.02）并继续下一轮
            engine.on_behavior_done(first["id"], False)
            second = await wait_for_event(
                sink, "behavior", predicate=lambda d: d["id"] != first["id"]
            )
            assert second["id"] != first["id"]
            assert engine.mood_snapshot()["energy"] == pytest.approx(0.78, abs=1e-6)
        finally:
            await engine.stop()

    asyncio.run(scenario())


def test_engine_timeout_fallback_and_partial_rest(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        "backend.modules.behavior.engine.DONE_TIMEOUT_BUFFER_SECONDS", 0.1
    )

    async def scenario() -> None:
        engine = BehaviorEngine(
            BehaviorConfig(),
            rng=random.Random(1),
            specs={"nap": tiny_spec("nap", max_duration_ms=50, energy_delta=0.16)},
        )
        sink = FakeSink()
        engine.set_connection(sink)
        # 不回 behavior_done → 超时兜底；恢复型行为按半额记账
        await engine._run_behavior(engine._specs["nap"])  # type: ignore[index]
        assert engine.mood_snapshot()["energy"] == pytest.approx(0.88, abs=1e-6)

    asyncio.run(scenario())


def test_engine_clears_connection_and_skips_when_closed() -> None:
    async def scenario() -> None:
        engine = BehaviorEngine(
            BehaviorConfig(idle_min_seconds=0.01, idle_max_seconds=0.02),
            rng=random.Random(3),
            specs={"walk": tiny_spec("walk")},
        )
        sink = FakeSink()
        engine.set_connection(sink)
        sink.closed = True

        engine.start()
        try:
            await asyncio.sleep(0.15)
            # 连接已断：不产生任何下发，且引擎状态被清理
            assert all(typ != "behavior" for typ, _ in sink.sent)
        finally:
            await engine.stop()
        assert engine._sink is None

        # _wait_done：等待期间断开 → 立即返回 None
        engine.set_connection(FakeSink())
        assert await engine._wait_done("b_x", timeout=1.0) is None

    asyncio.run(scenario())


def test_wait_done_receives_report() -> None:
    async def scenario() -> None:
        engine = BehaviorEngine(BehaviorConfig())
        engine.set_connection(FakeSink())

        async def report() -> None:
            await asyncio.sleep(0.02)
            engine.on_behavior_done("b_1", True)

        task = asyncio.create_task(report())
        assert await engine._wait_done("b_1", timeout=1.0) is True
        await task
        # 迟到/未知 id 不影响等待中的 future
        assert await engine._wait_done("b_2", timeout=0.05) is None

    asyncio.run(scenario())


def test_set_connection_first_wins_while_alive() -> None:
    """先到者得的绑定规则（回归：后到连接抢走行为通道导致自主行为不执行）。

    场景还原：首启时 llm.base_url 为空 → 设置向导窗自动弹出并**第二个**连上 WS。
    旧实现无条件覆盖，行为通道被抢到没有行为执行器的设置窗上，此后下发的
    walk/nap/look_around 全部无人执行，后端只能等超时报「未收到回报」。
    """
    engine = BehaviorEngine(BehaviorConfig())
    pet_sink = FakeSink()
    settings_sink = FakeSink()

    engine.set_connection(pet_sink)
    assert engine._sink is pet_sink

    # 后到连接（设置/向导窗）在宠物窗仍存活时被忽略——通道不丢
    engine.set_connection(settings_sink)
    assert engine._sink is pet_sink

    # 宠物窗断线（client_state 变 DISCONNECTED → is_closed() 为真）→ 新连接可接管（重连场景）
    pet_sink.closed = True
    engine.set_connection(settings_sink)
    assert engine._sink is settings_sink

    # None = 显式清除（显式清除后再连可重绑）
    engine.set_connection(None)
    assert engine._sink is None
    engine.set_connection(settings_sink)
    assert engine._sink is settings_sink


def test_engine_user_returned_pushes_wake_and_emotion() -> None:
    async def scenario() -> None:
        engine = BehaviorEngine(BehaviorConfig(idle_min_seconds=30, idle_max_seconds=60))
        sink = FakeSink()
        engine.set_connection(sink)
        engine.start()  # 提供事件循环引用（_push_wake 需要）
        try:
            engine.update_env(EnvUpdateData(system_idle_seconds=1200.0, pet_state="idle"))
            engine.update_env(EnvUpdateData(system_idle_seconds=20.0, pet_state="idle"))

            # 未在睡觉：只推轻问候表情
            emotion = await wait_for_event(sink, "emotion")
            assert emotion["emotion"] == "happy"

            # 正在打盹：额外推 state:idle（前端据此退出睡眠并回报 interrupted）
            engine._waiting_spec = BEHAVIORS["nap"]
            engine.update_env(EnvUpdateData(system_idle_seconds=1200.0, pet_state="idle"))
            engine.update_env(EnvUpdateData(system_idle_seconds=20.0, pet_state="idle"))
            state = await wait_for_event(
                sink, "state", predicate=lambda d: d["state"] == "idle"
            )
            assert state["state"] == "idle"
        finally:
            engine._waiting_spec = None
            await engine.stop()

    asyncio.run(scenario())


def test_note_pet_event_updates_mood() -> None:
    engine = BehaviorEngine(BehaviorConfig())
    assert engine.note_pet_event("drag_end") is None  # v1 无副作用
    before = engine.mood_snapshot()
    snapshot = engine.note_pet_event("tap_head")
    assert snapshot is not None
    assert snapshot["mood"] > before["mood"]


def test_engine_skip_reasons() -> None:
    engine = BehaviorEngine(BehaviorConfig(quiet_hours=["00:00-23:59"]))
    assert engine._skip_reason() == "无活跃连接"

    engine.set_connection(FakeSink())
    assert "免打扰" in (engine._skip_reason() or "")

    engine2 = BehaviorEngine(BehaviorConfig())
    engine2.set_connection(FakeSink())
    engine2.update_env(EnvUpdateData(pet_state="thinking"))
    assert "用户交互中" in (engine2._skip_reason() or "")


# ---------------------------------------------------------------- dispatcher 适配与集成


def test_connection_sink_is_closed_tracks_client_state() -> None:
    class _FakeWS:
        def __init__(self, state: Any) -> None:
            self.client_state = state

    from starlette.websockets import WebSocketState

    class _FakeCtx:
        def __init__(self, ws: Any) -> None:
            self.ws = ws

    assert _ConnectionSink(_FakeCtx(_FakeWS(WebSocketState.CONNECTED))).is_closed() is False
    assert _ConnectionSink(_FakeCtx(_FakeWS(WebSocketState.DISCONNECTED))).is_closed() is True
    # 拿不到状态（替身/异常实现）时保守视为未关闭
    assert _ConnectionSink(_FakeCtx(None)).is_closed() is False


def _make_msg(msg_type: str, data: dict[str, Any]) -> str:
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


async def _recv_until(ws: Any, msg_type: str, timeout: float = RECV_TIMEOUT) -> dict[str, Any]:
    """收事件直到出现目标类型（跳过其它事件）。"""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        raw = await asyncio.wait_for(ws.recv(), timeout=max(0.1, deadline - time.monotonic()))
        evt = json.loads(raw)
        if evt["type"] == msg_type:
            return evt
    raise AssertionError(f"等待事件 {msg_type} 超时")


def test_ws_integration_engine_dispatch_and_pet_event() -> None:
    """真 uvicorn + websockets：引擎下发 → 客户端回 done → 循环继续；pet_event/env_update 路由。"""

    async def scenario() -> None:
        engine = BehaviorEngine(
            BehaviorConfig(idle_min_seconds=0.05, idle_max_seconds=0.1),
            rng=random.Random(11),
            specs={"walk": tiny_spec("walk", max_duration_ms=100, cooldown=0.02)},
        )
        sessions = SessionManager()
        pipeline = ChatPipeline(provider=EchoLLMProvider())
        dispatcher = build_dispatcher(
            pipeline=pipeline,
            sessions=sessions,
            token=TOKEN,
            app_version="test",
            engine=engine,
        )
        app = create_app(dispatcher=dispatcher, app_version="test", voice_factory=None)
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
        serve_task = asyncio.create_task(server.serve())
        while not server.started:
            await asyncio.sleep(0.01)
        port = int(server.servers[0].sockets[0].getsockname()[1])
        engine.start()

        try:
            async with websockets.connect(f"ws://127.0.0.1:{port}/ws") as ws:
                await ws.send(
                    _make_msg(
                        "hello",
                        {"token": TOKEN, "protocol_version": 1, "app_version": "test"},
                    )
                )
                ack = json.loads(await asyncio.wait_for(ws.recv(), RECV_TIMEOUT))
                assert ack["type"] == "hello_ack" and ack["data"]["ok"] is True

                # 环境上报（行为决策依据；对话中静默的旁路信号）
                await ws.send(
                    _make_msg(
                        "env_update",
                        {
                            "pet_state": "idle",
                            "system_idle_seconds": 5.0,
                            "work_area": {"x": 0, "width": 1920},
                            "window_pos": {"x": 700},
                            "window_size": {"width": 400, "height": 400},
                        },
                    )
                )

                # 引擎自动下发行为
                behavior = await _recv_until(ws, "behavior")
                assert behavior["data"]["name"] == "walk"
                assert behavior["data"]["params"]["duration_ms"] == 100
                engine.set_connection  # 已由 hello 完成绑定

                # 回报完成 → energy 记账（-0.02）
                await ws.send(
                    _make_msg(
                        "behavior_done",
                        {"id": behavior["data"]["id"], "interrupted": False},
                    )
                )
                second = await _recv_until(ws, "behavior")
                assert second["data"]["id"] != behavior["data"]["id"]
                assert engine.mood_snapshot()["energy"] == pytest.approx(0.78, abs=1e-6)

                # 摸头 → 收到轻量情绪回应 + mood 上升
                mood_before = engine.mood_snapshot()["mood"]
                await ws.send(_make_msg("pet_event", {"kind": "tap_head", "payload": {}}))
                emotion = await _recv_until(ws, "emotion")
                assert emotion["data"]["emotion"] == "happy"
                assert engine.mood_snapshot()["mood"] > mood_before

                # 回一个 done，别让引擎悬挂着等（连接关闭时也会自动清理）
                await ws.send(
                    _make_msg(
                        "behavior_done",
                        {"id": second["data"]["id"], "interrupted": True},
                    )
                )
        finally:
            await engine.stop()
            server.should_exit = True
            await serve_task

    asyncio.run(scenario())
