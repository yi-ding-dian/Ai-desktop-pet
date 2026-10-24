"""提醒列表与时钟视图（2026-10-18；未装配提醒服务时不注册）。"""

from __future__ import annotations

from typing import TYPE_CHECKING, cast

from loguru import logger

from backend.interfaces.ws.handlers.types import HandlerRegistry
from backend.interfaces.ws.protocol import (
    AckRemindersData,
    DeleteReminderItemData,
    GetReminderHistoryData,
    GetRemindersData,
)

if TYPE_CHECKING:  # 避免与 server 运行时循环 import（类型注解专用）
    from backend.application.reminder_service import ReminderService
    from backend.interfaces.ws.protocol import ClientMessage
    from backend.interfaces.ws.server import ConnectionContext


def register_reminder_handlers(
    registry: HandlerRegistry, *, reminders: ReminderService | None = None
) -> None:
    """注册提醒相关处理器；未装配提醒服务时整组跳过。"""
    if reminders is None:
        return

    async def on_get_reminders(ctx: ConnectionContext, msg: ClientMessage) -> None:
        """拉取未读提醒快照（列表/未读数）。"""
        assert reminders is not None
        data = cast(GetRemindersData, msg.data)
        await ctx.send_event(
            "reminders", reminders.list_unread(limit=data.limit), reply_to=msg.envelope.id
        )

    async def on_ack_reminders(ctx: ConnectionContext, msg: ClientMessage) -> None:
        """标记提醒已读（按事件 id 或全部），回更新后的未读快照。"""
        assert reminders is not None
        data = cast(AckRemindersData, msg.data)
        await ctx.send_event(
            "reminders",
            reminders.acknowledge(data.ids, all_=data.all),
            reply_to=msg.envelope.id,
        )

    async def on_get_reminder_history(ctx: ConnectionContext, msg: ClientMessage) -> None:
        """拉取时钟视图：当天事件（已读 + 未读）+ 所有未到期计划，按到期时间正序。"""
        assert reminders is not None
        data = cast(GetReminderHistoryData, msg.data)
        await ctx.send_event(
            "reminder_history",
            reminders.list_history(data.date, limit=data.limit),
            reply_to=msg.envelope.id,
        )

    async def on_delete_reminder_item(ctx: ConnectionContext, msg: ClientMessage) -> None:
        """删除时钟视图里的一项（已触发事件或未到期计划），回两份刷新快照。"""
        assert reminders is not None
        data = cast(DeleteReminderItemData, msg.data)
        result = reminders.delete_item(data.id)
        if not result.get("ok"):
            logger.info("删除提醒项未命中：id={}", data.id)
        # 事件删除影响未读/历史；计划删除影响 pending；两份快照都回，前端自然收敛
        await ctx.send_event(
            "reminders",
            reminders.list_unread(limit=100),
            reply_to=msg.envelope.id,
        )
        await ctx.send_event(
            "reminder_history",
            reminders.list_history(None),
            reply_to=msg.envelope.id,
        )

    registry.register("get_reminders", on_get_reminders)
    registry.register("ack_reminders", on_ack_reminders)
    registry.register("get_reminder_history", on_get_reminder_history)
    registry.register("delete_reminder_item", on_delete_reminder_item)
