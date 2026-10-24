"""提醒工具：create_reminder / list_reminders / cancel_reminder（backend 型）。"""

from __future__ import annotations

from typing import Any

from backend.modules.tools.builtin.args import string_arg
from backend.modules.tools.registry import ToolRegistry, ToolSpec

#: 提醒时间参数说明（模型据此生成带偏移的本地 ISO 时间）
_DUE_AT_DESCRIPTION = (
    "本地 ISO 8601 带时区偏移，如 2026-10-18T09:00:00+08:00；"
    "必须晚于当前时间，最多 5 年"
)

_REPEAT_SCHEMA = {
    "type": "string",
    "enum": ["none", "daily", "weekdays", "weekly"],
    "description": "none=一次性 / daily=每天 / weekdays=工作日 / weekly=每周",
}


def register_reminder_tools(registry: ToolRegistry, reminders: Any) -> None:
    """注册提醒工具（handler 闭包持有提醒服务；服务接口见 application/reminder_service.py）。"""

    def create_reminder(args: dict[str, Any]) -> dict[str, Any]:
        return reminders.create_from_tool(
            text=string_arg(args, "text"),
            due_at=string_arg(args, "due_at"),
            repeat=string_arg(args, "repeat") or "none",
        )

    def list_reminders(args: dict[str, Any]) -> dict[str, Any]:
        raw = args.get("limit")
        try:
            limit = int(raw) if raw is not None else 20
        except (TypeError, ValueError):
            limit = 20
        return reminders.list_for_tool(limit=limit)

    def cancel_reminder(args: dict[str, Any]) -> dict[str, Any]:
        return reminders.cancel_from_tool(key=string_arg(args, "key"))

    registry.register(
        ToolSpec(
            name="create_reminder",
            description=(
                "创建定时提醒，到点后主动提醒用户。"
                "用户说“提醒我 / 到点告诉我”时调用。"
                "相对时间先按当前时间换算成绝对 ISO 时间再传。"
            ),
            parameters={
                "type": "object",
                "properties": {
                    "text": {
                        "type": "string",
                        "description": "提醒内容（1–200 字）",
                    },
                    "due_at": {"type": "string", "description": _DUE_AT_DESCRIPTION},
                    "repeat": _REPEAT_SCHEMA,
                },
                "required": ["text", "due_at"],
            },
            executor="backend",
            handler=create_reminder,
            ack="好嘞，提醒给你设好啦～",
        )
    )
    registry.register(
        ToolSpec(
            name="list_reminders",
            description="查看用户当前还未触发的提醒（用户问“我有哪些提醒 / 待办”时调用）。",
            parameters={
                "type": "object",
                "properties": {
                    "limit": {
                        "type": "integer",
                        "description": "最多返回几条（默认 20）",
                    }
                },
            },
            executor="backend",
            handler=list_reminders,
            ack="我看看有哪些提醒～",
        )
    )
    registry.register(
        ToolSpec(
            name="cancel_reminder",
            description=(
                "取消一条未触发的提醒（用户说“取消 xx 提醒 / 不用提醒我了”时调用）。"
                "key 可以传提醒 id，也可以传提醒内容里的关键词。"
            ),
            parameters={
                "type": "object",
                "properties": {
                    "key": {
                        "type": "string",
                        "description": "提醒 id 或提醒内容中的关键词（如“交房租”）",
                    }
                },
                "required": ["key"],
            },
            executor="backend",
            handler=cancel_reminder,
            ack="好，已经帮你取消啦～",
        )
    )
