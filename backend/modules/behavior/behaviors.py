"""v1 行为表（设计文档 §4.5.2 权重表）。

结构可扩展：新增行为 = 在 ``BEHAVIORS`` 里加一条 spec（基础权重 / 时长 / 冷却 /
精力记账 / 前置条件 / 参数工厂），其余链路（权重掷骰 / 情境调制 / 超时兜底）零改动。

v1 四行为：
- ``walk``        左/右短移动（距离随机，考虑屏幕边界）；
- ``look_around`` 原地张望；
- ``nap``         打盹短睡（精力偏低 / 深夜 / 用户离开时倾向）；
- ``sleep``       深睡（仅精力很低或深夜可选）。

参数约定（前端执行器按 name 分发，params 为指令级参数）：
- 所有行为带 ``duration_ms``（引擎的预期时长，前端按它执行、引擎按它算超时兜底）；
- ``walk`` 另带 ``direction``（"left"/"right"）与 ``distance``（px）。
"""

from __future__ import annotations

import random
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Callable

from backend.modules.behavior import rules

# ---------------------------------------------------------------- 参数常量

#: 走动速度（px/秒）——计算 duration_ms 用；与前端缓动配合决定"走路观感"
WALK_SPEED_PX_PER_SECOND = 140.0
#: 单次走动距离范围（px）
WALK_DISTANCE_RANGE = (120, 320)
#: 走动距离下限（贴边时缩短用）
MIN_WALK_DISTANCE = 40
#: 走动时长下限（毫秒）
MIN_WALK_DURATION_MS = 400
#: 窗口缺省尺寸（env_update 缺 window_size 时的兜底，与前端 PET_WINDOW 基准一致）
DEFAULT_WINDOW_WIDTH = 400

#: nap / sleep 的时长范围（毫秒）
NAP_DURATION_RANGE = (20_000, 45_000)
SLEEP_DURATION_RANGE = (60_000, 150_000)
#: look_around 时长范围（毫秒）
LOOK_AROUND_DURATION_RANGE = (2_500, 5_000)

#: nap / sleep 前置阈值
NAP_ENERGY_THRESHOLD = 0.55
SLEEP_ENERGY_THRESHOLD = 0.3


@dataclass(frozen=True)
class BehaviorContext:
    """一次决策的输入快照（engine 组装；纯数据，便于单测构造）。"""

    now: datetime
    mood: float
    energy: float
    system_idle_seconds: float | None = None
    pet_state: str | None = None
    #: env_update 上报的几何（宽容 dict；缺省时相关感知逻辑自动跳过）
    work_area: dict[str, Any] | None = None
    window_pos: dict[str, Any] | None = None
    window_size: dict[str, Any] | None = None
    #: 用户刚回到电脑前（短窗口标记，见 engine）
    user_just_returned: bool = False


@dataclass(frozen=True)
class BehaviorSpec:
    """一条行为的静态定义。"""

    name: str
    base_weight: float
    min_duration_ms: int
    max_duration_ms: int
    cooldown_seconds: float
    #: 精力记账：正 = 恢复，负 = 消耗（完成时全额；恢复型行为被打断按半额，见 engine）
    energy_delta: float
    precondition: Callable[[BehaviorContext], bool]
    make_params: Callable[[BehaviorContext, random.Random], dict[str, Any]]
    description: str = ""

    @property
    def max_duration_seconds(self) -> float:
        return self.max_duration_ms / 1000.0


# ---------------------------------------------------------------- 前置条件


def _always(_ctx: BehaviorContext) -> bool:
    return True


def _can_nap(ctx: BehaviorContext) -> bool:
    """打盹：精力偏低 / 深夜 / 用户离开（>15 分钟）时可选。"""
    if ctx.energy < NAP_ENERGY_THRESHOLD:
        return True
    if rules.time_bucket(ctx.now) == "night":
        return True
    return (
        ctx.system_idle_seconds is not None
        and ctx.system_idle_seconds > rules.AWAY_THRESHOLD_SECONDS
    )


def _can_sleep(ctx: BehaviorContext) -> bool:
    """深睡：仅精力很低或深夜。"""
    return ctx.energy < SLEEP_ENERGY_THRESHOLD or rules.time_bucket(ctx.now) == "night"


# ---------------------------------------------------------------- 参数工厂


def _as_number(value: Any) -> float | None:
    """宽容取数：仅接受 int/float（bool 除外），其余（含字符串）视为缺失。"""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return float(value)


def fit_walk_to_screen(
    ctx: BehaviorContext, direction: str, distance: int
) -> tuple[str, int]:
    """屏幕边界感知：所选方向剩余空间不足时，翻转方向或缩短距离。

    仅在 env_update 几何齐全时生效；任一字段缺失则原样返回（主进程移动端还会再 clamp）。
    """
    area = ctx.work_area or {}
    pos = ctx.window_pos or {}
    size = ctx.window_size or {}
    wa_x = _as_number(area.get("x"))
    wa_width = _as_number(area.get("width"))
    win_x = _as_number(pos.get("x"))
    win_width = _as_number(size.get("width")) or DEFAULT_WINDOW_WIDTH
    if wa_x is None or wa_width is None or win_x is None:
        return direction, distance

    left_space = win_x - wa_x
    right_space = (wa_x + wa_width) - (win_x + win_width)
    if direction == "right" and right_space < distance:
        if left_space >= distance:
            return "left", distance
        distance = int(max(MIN_WALK_DISTANCE, min(right_space, max(left_space, 0))))
    elif direction == "left" and left_space < distance:
        if right_space >= distance:
            return "right", distance
        distance = int(max(MIN_WALK_DISTANCE, min(left_space, max(right_space, 0))))
    return direction, distance


def _walk_params(ctx: BehaviorContext, rng: random.Random) -> dict[str, Any]:
    direction = rng.choice(("left", "right"))
    distance = rng.randint(*WALK_DISTANCE_RANGE)
    direction, distance = fit_walk_to_screen(ctx, direction, distance)
    duration_ms = max(
        MIN_WALK_DURATION_MS, round(distance / WALK_SPEED_PX_PER_SECOND * 1000)
    )
    return {"direction": direction, "distance": distance, "duration_ms": duration_ms}


def _duration_only(rng_range: tuple[int, int]) -> Callable[[BehaviorContext, random.Random], dict[str, Any]]:
    def factory(_ctx: BehaviorContext, rng: random.Random) -> dict[str, Any]:
        return {"duration_ms": rng.randint(*rng_range)}

    return factory


# ---------------------------------------------------------------- 行为表

BEHAVIORS: dict[str, BehaviorSpec] = {
    "walk": BehaviorSpec(
        name="walk",
        base_weight=1.0,
        min_duration_ms=800,
        max_duration_ms=3_000,
        cooldown_seconds=6.0,
        energy_delta=-0.02,
        precondition=_always,
        make_params=_walk_params,
        description="左/右短移动（窗口缓动 + 行走动画）",
    ),
    "look_around": BehaviorSpec(
        name="look_around",
        base_weight=0.8,
        min_duration_ms=LOOK_AROUND_DURATION_RANGE[0],
        max_duration_ms=LOOK_AROUND_DURATION_RANGE[1],
        cooldown_seconds=4.0,
        energy_delta=-0.01,
        precondition=_always,
        make_params=_duration_only(LOOK_AROUND_DURATION_RANGE),
        description="原地张望（头部/视线扫视）",
    ),
    "nap": BehaviorSpec(
        name="nap",
        base_weight=0.5,
        min_duration_ms=NAP_DURATION_RANGE[0],
        max_duration_ms=NAP_DURATION_RANGE[1],
        cooldown_seconds=20.0,
        energy_delta=0.15,
        precondition=_can_nap,
        make_params=_duration_only(NAP_DURATION_RANGE),
        description="打盹短睡（恢复少量精力）",
    ),
    "sleep": BehaviorSpec(
        name="sleep",
        base_weight=0.25,
        min_duration_ms=SLEEP_DURATION_RANGE[0],
        max_duration_ms=SLEEP_DURATION_RANGE[1],
        cooldown_seconds=60.0,
        energy_delta=0.35,
        precondition=_can_sleep,
        make_params=_duration_only(SLEEP_DURATION_RANGE),
        description="深睡（仅精力很低或深夜；恢复大量精力）",
    ),
}


# ---------------------------------------------------------------- 掷骰


def candidate_weights(
    ctx: BehaviorContext, specs: dict[str, BehaviorSpec] | None = None
) -> dict[str, float]:
    """前置过滤 + 情境调制后的候选权重（仅保留 > 0 的条目）。"""
    table = specs if specs is not None else BEHAVIORS
    weights = {
        name: spec.base_weight for name, spec in table.items() if spec.precondition(ctx)
    }
    rules.modulate(
        weights,
        now=ctx.now,
        energy=ctx.energy,
        mood=ctx.mood,
        system_idle_seconds=ctx.system_idle_seconds,
        wake_boost=ctx.user_just_returned,
    )
    return {name: weight for name, weight in weights.items() if weight > 0}


def choose_behavior(
    ctx: BehaviorContext,
    rng: random.Random,
    specs: dict[str, BehaviorSpec] | None = None,
) -> BehaviorSpec | None:
    """权重掷骰；无候选（前置全不过 / 权重全 0）返回 None。"""
    table = specs if specs is not None else BEHAVIORS
    weights = candidate_weights(ctx, table)
    if not weights:
        return None
    names = list(weights.keys())
    chosen = rng.choices(names, weights=[weights[n] for n in names], k=1)[0]
    return table[chosen]


def build_params(
    spec: BehaviorSpec, ctx: BehaviorContext, rng: random.Random
) -> dict[str, Any]:
    """构造行为指令参数（含 duration_ms 约定，见模块 docstring）。"""
    return spec.make_params(ctx, rng)
