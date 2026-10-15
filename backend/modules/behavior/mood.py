"""行为引擎软状态（mood / energy，0–1）——设计文档 §4.5.3。

- 只改变"它今天什么样"：mood 调制行为权重（活泼 ↔ 蔫），energy 低 → 更倾向睡眠；
- 有意不做饥饿/清洁等衰减惩罚（那是养成游戏，不是桌宠）；
- **v1 为内存态**：进程重启即重置。持久化（SQLite pet.db 或 JSON）留待后续版本，
  届时只需在本类外层加存取，接口不变；
- 所有变更都做边界截断（mood ∈ [MOOD_FLOOR, 1]，energy ∈ [0, 1]），调用方不必自行 clamp。
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field

#: 互动后多久开始 mood 缓降（秒）
IDLE_DECAY_AFTER_SECONDS = 30 * 60
#: 缓降速率（每分钟）
IDLE_DECAY_PER_MINUTE = 0.02
#: mood 缓降下限（不蔫到底——桌宠不做惩罚机制）
MOOD_FLOOR = 0.2


def _clamp(value: float, lo: float, hi: float) -> float:
    return lo if value < lo else hi if value > hi else value


@dataclass
class MoodState:
    """mood / energy 软状态（数值含义见模块 docstring）。"""

    #: 心情 0–1（初始略偏活泼）
    mood: float = 0.6
    #: 精力 0–1（初始较精神）
    energy: float = 0.8
    #: 最近一次用户互动时间戳（秒，time.time()）
    last_interaction_ts: float = field(default_factory=time.time)
    #: 上次缓降结算时间戳（内部游标，避免重复扣减）
    _last_decay_ts: float = field(default_factory=time.time, repr=False)

    # ---------------------------------------------------------------- 互动输入

    def touch(self, now: float | None = None) -> None:
        """记录一次用户互动（刷新缓降计时）。"""
        self.last_interaction_ts = now if now is not None else time.time()

    def on_pet_tapped(self, now: float | None = None) -> None:
        """被摸头：mood 明显上升（设计文档 §7.4：摸头 → mood 提升）。"""
        self.touch(now)
        self.mood = _clamp(self.mood + 0.15, MOOD_FLOOR, 1.0)
        self.energy = _clamp(self.energy + 0.03, 0.0, 1.0)

    def on_conversation(self, now: float | None = None) -> None:
        """被聊（一轮对话）：mood 小幅上升；说话也消耗一点精力。"""
        self.touch(now)
        self.mood = _clamp(self.mood + 0.08, MOOD_FLOOR, 1.0)
        self.energy = _clamp(self.energy - 0.02, 0.0, 1.0)

    def on_user_returned(self, now: float | None = None) -> None:
        """用户回到电脑前：mood 小幅回升（"你回来啦"）。"""
        self.touch(now)
        self.mood = _clamp(self.mood + 0.05, MOOD_FLOOR, 1.0)

    # ---------------------------------------------------------------- 活动记账

    def apply_energy_delta(self, delta: float) -> None:
        """活动/休息的精力记账：delta > 0 恢复，delta < 0 消耗。"""
        self.energy = _clamp(self.energy + delta, 0.0, 1.0)

    def apply_idle_decay(self, now: float | None = None) -> float:
        """久无互动的 mood 缓降（每轮决策前调用）；返回本次衰减量（0 = 未衰减）。"""
        ts = now if now is not None else time.time()
        if ts - self.last_interaction_ts < IDLE_DECAY_AFTER_SECONDS:
            self._last_decay_ts = ts
            return 0.0
        elapsed = max(0.0, ts - self._last_decay_ts)
        self._last_decay_ts = ts
        decay = (elapsed / 60.0) * IDLE_DECAY_PER_MINUTE
        if decay <= 0:
            return 0.0
        before = self.mood
        self.mood = _clamp(self.mood - decay, MOOD_FLOOR, 1.0)
        return before - self.mood

    # ---------------------------------------------------------------- 快照

    def snapshot(self) -> dict[str, float]:
        """只读快照（日志/测试/未来的 API 暴露）。"""
        return {"mood": round(self.mood, 4), "energy": round(self.energy, 4)}
