"""宠物交互与自主行为事件（tap_head / behavior_done / env_update）。"""

from __future__ import annotations

from typing import TYPE_CHECKING, cast

from loguru import logger

from backend.interfaces.ws.handlers.types import HandlerRegistry
from backend.interfaces.ws.protocol import BehaviorDoneData, EnvUpdateData, PetEventData

if TYPE_CHECKING:  # 避免与 server 运行时循环 import（类型注解专用）
    from backend.interfaces.ws.protocol import ClientMessage
    from backend.interfaces.ws.server import ConnectionContext
    from backend.modules.behavior.engine import BehaviorEngine

#: tap_head 的轻量情绪回应（v1 不调 LLM；真正"回话"属 proactive，后续版本）
_TAP_HEAD_EMOTION = "happy"
_TAP_HEAD_INTENSITY = 0.9


def register_pet_handlers(
    registry: HandlerRegistry, *, engine: BehaviorEngine | None = None
) -> None:
    """注册宠物/行为事件处理器（未装配引擎时走惰性兜底，不阻断其余事件）。"""

    async def on_pet_event(ctx: ConnectionContext, msg: ClientMessage) -> None:
        """宠物交互事件（§3.2）：tap_head → mood ↑ + 轻量情绪回应（v1 不调 LLM）。"""
        data = cast(PetEventData, msg.data)
        mood = engine.note_pet_event(data.kind) if engine is not None else None
        if data.kind == "tap_head":
            await ctx.send_event(
                "emotion",
                {
                    "message_id": "",
                    "emotion": _TAP_HEAD_EMOTION,
                    "intensity": _TAP_HEAD_INTENSITY,
                },
            )
            logger.info("tap_head：已推 emotion({})，mood={}", _TAP_HEAD_EMOTION, mood)
        else:
            # drag_end / idle_touch：v1 只记录（行为引擎不依赖，前端暂不上报）
            logger.debug("pet_event kind={} payload={}（v1 无回应）", data.kind, data.payload)

    async def on_behavior_done(ctx: ConnectionContext, msg: ClientMessage) -> None:
        """行为执行完成/被中断回报（§7.4）：唤醒引擎中等待中的本轮行为。"""
        data = cast(BehaviorDoneData, msg.data)
        if engine is not None:
            engine.on_behavior_done(data.id, data.interrupted)
        else:
            logger.debug("behavior_done id={}（未装配行为引擎，忽略）", data.id)

    async def on_env_update(ctx: ConnectionContext, msg: ClientMessage) -> None:
        """环境上报（§4.5.5）：更新引擎的环境快照（几何/系统空闲/宠物状态）。"""
        data = cast(EnvUpdateData, msg.data)
        if engine is not None:
            engine.update_env(data)

    registry.register("pet_event", on_pet_event)
    registry.register("behavior_done", on_behavior_done)
    registry.register("env_update", on_env_update)
