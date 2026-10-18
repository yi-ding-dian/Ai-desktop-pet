"""内置工具集：``build_default_registry`` 装配本产品的全部内置工具。

新增内置工具时：在本文件追加 ``register(ToolSpec(...))``，并同步
``prompts/capabilities.md`` 的能力清单（模型据此知道何时调用）。

``reminders``（可选注入，2026-10-18）：提醒服务（application 层实现）。
传了就注册 create_reminder / list_reminders / cancel_reminder 三个 **backend 型**
工具——handler 只做参数转发，校验/落库/文案都在提醒域；不传（旧装配/单测）
时注册表与旧版逐字一致（仅 open_settings），避免模块间硬依赖。
"""

from __future__ import annotations

from typing import Any

from backend.modules.tools.registry import ToolRegistry, ToolSpec


def build_default_registry(reminders: Any | None = None) -> ToolRegistry:
    """构建内置工具注册表（每次返回全新实例，避免调用方之间共享可变状态）。"""
    registry = ToolRegistry()
    registry.register(
        ToolSpec(
            name="open_settings",
            description=(
                "打开小兔的设置面板"
                "（用户想改配置、换模型或服务商、改名字、主题、声音等时使用）"
            ),
            parameters={"type": "object", "properties": {}},
            executor="frontend",
            ack="好嘞，设置给你开好啦~ 改完记得保存哦",
        )
    )
    if reminders is not None:
        _register_reminder_tools(registry, reminders)
    return registry


#: 提醒时间参数说明（模型据此生成带偏移的本地 ISO 时间）
_DUE_AT_DESCRIPTION = (
    "提醒的本地时间，ISO 8601 带时区偏移，例如 2026-10-18T09:00:00+08:00。"
    "必须晚于当前时间（系统提示里会给出当前时间），最多 5 年内。"
)

_REPEAT_SCHEMA = {
    "type": "string",
    "enum": ["none", "daily", "weekdays", "weekly"],
    "description": "重复规则：none=一次性（默认）/ daily=每天 / weekdays=工作日 / weekly=每周",
}


def _string_arg(args: dict[str, Any], key: str) -> str:
    """取字符串参数：非字符串（含 None / 数字）一律按空串——避免 str(None) 变成 "None"。"""
    value = args.get(key)
    return value.strip() if isinstance(value, str) else ""


def _register_reminder_tools(registry: ToolRegistry, reminders: Any) -> None:
    """注册提醒工具（handler 闭包持有提醒服务；服务接口见 application/reminder_service.py）。"""

    def create_reminder(args: dict[str, Any]) -> dict[str, Any]:
        return reminders.create_from_tool(
            text=_string_arg(args, "text"),
            due_at=_string_arg(args, "due_at"),
            repeat=_string_arg(args, "repeat") or "none",
        )

    def list_reminders(args: dict[str, Any]) -> dict[str, Any]:
        raw = args.get("limit")
        try:
            limit = int(raw) if raw is not None else 20
        except (TypeError, ValueError):
            limit = 20
        return reminders.list_for_tool(limit=limit)

    def cancel_reminder(args: dict[str, Any]) -> dict[str, Any]:
        return reminders.cancel_from_tool(key=_string_arg(args, "key"))

    registry.register(
        ToolSpec(
            name="create_reminder",
            description=(
                "创建一条定时提醒：到点后小兔会主动弹气泡提醒用户（语音可在设置中开启）。"
                "用户说“提醒我 / 到点告诉我 / 每天几点提醒我”时调用。"
                "相对时间（如“20 分钟后”）要先按当前时间换算成绝对 ISO 时间再传。"
            ),
            parameters={
                "type": "object",
                "properties": {
                    "text": {
                        "type": "string",
                        "description": "要提醒用户的事情（1–200 字，如“交房租”）",
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
