"""行为引擎情境调制规则（设计文档 §4.5.2）——纯函数，便于单测。

调制链路：基础权重 → 前置条件过滤（behaviors.py）→ 本文件各 ``apply_*`` 逐层乘算。
本模块不持有状态：时间/软状态/环境由调用方（engine）传入。

免打扰（quiet_hours）：配置形如 ``["23:00-07:00", "12:30-13:30"]``（本地时间，可跨午夜）；
命中期间引擎整体静默（只保留前端微行为）。空列表 = 无免打扰。
"""

from __future__ import annotations

from datetime import datetime
from typing import Literal

TimeBucket = Literal["day", "evening", "night"]

#: 白天起点（含）与夜晚起点（含），用于时段分桶
DAY_START_HOUR = 7
NIGHT_START_HOUR = 23

#: 用户离开判定阈值（秒）：system_idle_seconds 超过它视为"人不在"
AWAY_THRESHOLD_SECONDS = 15 * 60
#: 用户回来判定阈值（秒）：从"离开"降到它以下视为"回来了"
BACK_THRESHOLD_SECONDS = 2 * 60

#: 对话/拖拽进行中的状态（引擎静默，不抢戏）
_ENGAGED_STATES = frozenset({"thinking", "speaking", "dragging"})


# ---------------------------------------------------------------- 时间


def time_bucket(now: datetime) -> TimeBucket:
    """时段分桶：白天活泼、深夜安静。"""
    hour = now.hour
    if DAY_START_HOUR <= hour < NIGHT_START_HOUR - 4:  # 7–19
        return "day"
    if NIGHT_START_HOUR - 4 <= hour < NIGHT_START_HOUR:  # 19–23
        return "evening"
    return "night"  # 23–7


def parse_quiet_hours(specs: list[str]) -> list[tuple[int, int]]:
    """把 ``"HH:MM-HH:MM"`` 列表解析为 ``[(start_minute, end_minute)]``（跨午夜原样保留）。

    非法条目抛 ValueError（配置错误应尽早暴露，由 engine 装配时捕获记日志）。
    """
    spans: list[tuple[int, int]] = []
    for spec in specs:
        text = spec.strip()
        if not text:
            continue
        parts = text.split("-")
        if len(parts) != 2:
            raise ValueError(f"quiet_hours 条目格式应为 'HH:MM-HH:MM'：{spec!r}")
        spans.append((_parse_hhmm(parts[0]), _parse_hhmm(parts[1])))
    return spans


def _parse_hhmm(text: str) -> int:
    pieces = text.strip().split(":")
    if len(pieces) != 2 or not all(p.isdigit() for p in pieces):
        raise ValueError(f"时间格式应为 'HH:MM'：{text!r}")
    hour, minute = int(pieces[0]), int(pieces[1])
    if not (0 <= hour <= 23 and 0 <= minute <= 59):
        raise ValueError(f"时间越界：{text!r}")
    return hour * 60 + minute


def in_quiet_hours(now: datetime, specs: list[str]) -> bool:
    """当前是否处于免打扰时段（specs 为空 = 恒 False）。"""
    if not specs:
        return False
    minute = now.hour * 60 + now.minute
    for start, end in parse_quiet_hours(specs):
        if start == end:
            continue  # 空区间
        if start < end:
            if start <= minute < end:
                return True
        else:  # 跨午夜，如 23:00-07:00
            if minute >= start or minute < end:
                return True
    return False


# ---------------------------------------------------------------- 用户在场


def user_returned(
    prev_idle_seconds: float,
    cur_idle_seconds: float,
    *,
    away_seconds: float = AWAY_THRESHOLD_SECONDS,
    back_seconds: float = BACK_THRESHOLD_SECONDS,
) -> bool:
    """system_idle_seconds 从"离开"骤降到"回来"（设计文档 §4.5.2：回来时唤醒 + 轻问候）。"""
    return prev_idle_seconds > away_seconds and cur_idle_seconds < back_seconds


def is_engaged(pet_state: str | None) -> bool:
    """对话/拖拽进行中（引擎必须静默——行为永不抢占用户交互）。"""
    return pet_state in _ENGAGED_STATES


# ---------------------------------------------------------------- 权重调制
# 约定：原地乘算（就地修改传入 dict），系数集中在这里便于调整口味。

_TIME_FACTORS: dict[TimeBucket, dict[str, float]] = {
    "day": {"walk": 1.3, "look_around": 1.2},
    "evening": {},
    "night": {"walk": 0.35, "look_around": 0.5, "nap": 1.6, "sleep": 2.2},
}

_LOW_ENERGY_THRESHOLD = 0.35
_HIGH_ENERGY_THRESHOLD = 0.75
_LOW_ENERGY_FACTORS = {"nap": 1.8, "sleep": 1.6, "walk": 0.6}
_HIGH_ENERGY_FACTORS = {"walk": 1.15}

_LOW_MOOD_THRESHOLD = 0.35
_HIGH_MOOD_THRESHOLD = 0.7
_LOW_MOOD_FACTORS = {"walk": 0.75, "nap": 1.15}
_HIGH_MOOD_FACTORS = {"walk": 1.2, "look_around": 1.15}

_AWAY_IDLE_SECONDS = AWAY_THRESHOLD_SECONDS
_AWAY_FACTORS = {"nap": 1.5, "sleep": 1.8, "look_around": 0.6, "walk": 0.7}
_LONG_AWAY_IDLE_SECONDS = 30 * 60
_LONG_AWAY_FACTORS = {"sleep": 1.4}

#: 用户刚回来：下一轮偏活跃（"轻问候倾向"，配合 engine 推的 happy 表情）
_WAKE_BOOST_FACTORS = {"walk": 1.8, "look_around": 1.6, "nap": 0.4}


def _apply_factors(weights: dict[str, float], factors: dict[str, float]) -> None:
    for name, factor in factors.items():
        if name in weights:
            weights[name] *= factor


def apply_time_of_day(weights: dict[str, float], bucket: TimeBucket) -> None:
    """时间段：白天活泼、深夜安静（nap/sleep 加权）。"""
    _apply_factors(weights, _TIME_FACTORS[bucket])


def apply_energy(weights: dict[str, float], energy: float) -> None:
    """精力：低 → 倾向睡眠类；高 → 更爱动。"""
    if energy < _LOW_ENERGY_THRESHOLD:
        _apply_factors(weights, _LOW_ENERGY_FACTORS)
    elif energy > _HIGH_ENERGY_THRESHOLD:
        _apply_factors(weights, _HIGH_ENERGY_FACTORS)


def apply_mood(weights: dict[str, float], mood: float) -> None:
    """心情：高 → 活泼；低 → 蔫（少走动、多打盹）。"""
    if mood > _HIGH_MOOD_THRESHOLD:
        _apply_factors(weights, _HIGH_MOOD_FACTORS)
    elif mood < _LOW_MOOD_THRESHOLD:
        _apply_factors(weights, _LOW_MOOD_FACTORS)


def apply_system_idle(weights: dict[str, float], system_idle_seconds: float | None) -> None:
    """用户离开（idle 超阈值）→ 偏睡觉；离开很久 → 深睡进一步加权。"""
    if system_idle_seconds is None:
        return
    if system_idle_seconds > _AWAY_IDLE_SECONDS:
        _apply_factors(weights, _AWAY_FACTORS)
    if system_idle_seconds > _LONG_AWAY_IDLE_SECONDS:
        _apply_factors(weights, _LONG_AWAY_FACTORS)


def apply_wake_boost(weights: dict[str, float]) -> None:
    """用户刚回来（user_returned 事件后的短窗口内）。"""
    _apply_factors(weights, _WAKE_BOOST_FACTORS)


def modulate(
    weights: dict[str, float],
    *,
    now: datetime,
    energy: float,
    mood: float,
    system_idle_seconds: float | None,
    wake_boost: bool = False,
) -> dict[str, float]:
    """完整调制（就地修改并返回 weights，便于链式调用与测试）。"""
    apply_time_of_day(weights, time_bucket(now))
    apply_energy(weights, energy)
    apply_mood(weights, mood)
    apply_system_idle(weights, system_idle_seconds)
    if wake_boost:
        apply_wake_boost(weights)
    return weights
