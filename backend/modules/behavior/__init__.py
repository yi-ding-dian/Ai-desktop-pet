"""behavior 模块（Phase 3 自主行为引擎，设计文档 §4.5）——"生命感"核心。

- ``engine``：asyncio 主循环（空闲计时 → 掷骰 → 下发指令 → 等回报 → 记账 → 冷却）；
- ``behaviors``：v1 行为表（walk / look_around / nap / sleep，结构可扩展）；
- ``mood``：mood / energy 软状态（v1 内存态，持久化留待后续）；
- ``rules``：情境调制（时段 / 精力 / 心情 / 用户在场 / 免打扰）与唤醒检测。

依赖方向：modules 不依赖 interfaces / application——引擎通过 ``BehaviorSink``
协议与连接解耦，WS 适配在 ``interfaces/ws/dispatcher.py`` 完成。
"""

from backend.modules.behavior import rules
from backend.modules.behavior.behaviors import (
    BEHAVIORS,
    BehaviorContext,
    BehaviorSpec,
    build_params,
    choose_behavior,
)
from backend.modules.behavior.engine import BehaviorEngine, BehaviorSink
from backend.modules.behavior.mood import MoodState

__all__ = [
    "BEHAVIORS",
    "BehaviorContext",
    "BehaviorEngine",
    "BehaviorSink",
    "BehaviorSpec",
    "MoodState",
    "build_params",
    "choose_behavior",
    "rules",
]
