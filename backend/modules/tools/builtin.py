"""内置工具集：``build_default_registry`` 装配本产品的全部内置工具。

新增内置工具时：在本文件追加 ``register(ToolSpec(...))``，并同步
``prompts/capabilities.md`` 的能力清单（模型据此知道何时调用）。

可选注入（不传时注册表与旧版一致，避免模块间硬依赖）：

- ``reminders``（2026-10-18）：提醒服务（application 层实现）——注册
  create_reminder / list_reminders / cancel_reminder 三个 **backend 型**工具；
- ``notebook``（2026-10-18）：记忆本服务（application 层实现）——注册
  save_item / list_items / rename_item / delete_item / open_item / delete_path。
  ``open_item`` / ``delete_path`` 是 **frontend 型**，但带 ``prepare``：
  模型只传名字，chat 管道派发前由后端解析成精确值并校验用户本轮原话；
  ``delete_path`` 到前端后还要弹确认气泡，用户点「删除」才由主进程移入回收站。
"""

from __future__ import annotations

from typing import Any

from backend.modules.tools.registry import ToolRegistry, ToolSpec


def build_default_registry(
    reminders: Any | None = None,
    notebook: Any | None = None,
) -> ToolRegistry:
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
    if notebook is not None:
        _register_notebook_tools(registry, notebook)
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


# ---------------------------------------------------------------- 记忆本（2026-10-18）


def _register_notebook_tools(registry: ToolRegistry, notebook: Any) -> None:
    """注册记忆本工具（服务接口见 application/notebook_service.py）。"""

    def save_item(args: dict[str, Any]) -> dict[str, Any]:
        return notebook.save_from_tool(args.get("items"))

    def list_items(args: dict[str, Any]) -> dict[str, Any]:
        raw_limit = args.get("limit")
        try:
            limit = int(raw_limit) if raw_limit is not None else 50
        except (TypeError, ValueError):
            limit = 50
        return notebook.list_from_tool(kind=_string_arg(args, "kind") or None, limit=limit)

    def rename_item(args: dict[str, Any]) -> dict[str, Any]:
        return notebook.rename_from_tool(
            old_name=_string_arg(args, "old_name"),
            new_name=_string_arg(args, "new_name"),
        )

    def delete_item(args: dict[str, Any], user_text: str) -> dict[str, Any]:
        return notebook.delete_from_tool(args.get("names"), user_text)

    registry.register(
        ToolSpec(
            name="save_item",
            description=(
                "把用户明确要求记住的东西存到「记忆本」（本地精确清单）。"
                "用户说“记住 / 记一下 / 记下 / 收藏 / 存到记忆本 / 记到记忆本”时调用，"
                "不要只口头答应。items 是数组，可一次存多条（最多 10 条）；每项："
                "name（以后点名用的短名字，可省略）、kind（link=网页链接 / path=本机文件或"
                "文件夹 / text=短文本，可省略自动判断）、value（完整 http/https 链接、绝对路径"
                "或短文本）。同名再次保存会更新值，不会重复。用户没给名字时自动起名并在"
                "回复里告诉用户；用户给了名字就用用户的。不要保存密码、密钥等敏感信息。"
            ),
            parameters={
                "type": "object",
                "properties": {
                    "items": {
                        "type": "array",
                        "minItems": 1,
                        "maxItems": 10,
                        "items": {
                            "type": "object",
                            "properties": {
                                "name": {
                                    "type": "string",
                                    "description": "短名字（1–30 字，如“博客”“项目目录”）",
                                },
                                "kind": {
                                    "type": "string",
                                    "enum": ["link", "path", "text"],
                                    "description": "link=网页链接 / path=本机路径 / text=短文本",
                                },
                                "value": {
                                    "type": "string",
                                    "description": "要记住的内容：完整链接、绝对路径或短文本",
                                },
                            },
                            "required": ["value"],
                        },
                    }
                },
                "required": ["items"],
            },
            executor="backend",
            handler=save_item,
            ack="记好啦～",
        )
    )
    registry.register(
        ToolSpec(
            name="list_items",
            description=(
                "查看记忆本里的条目（用户问“我记了什么 / 有哪些链接 / 某个名字是什么”"
                "或需要某个条目的具体地址/内容时调用）。会顺手检查本机路径是否还存在。"
            ),
            parameters={
                "type": "object",
                "properties": {
                    "kind": {
                        "type": "string",
                        "enum": ["link", "path", "text"],
                        "description": "只看某一类（省略=全部）",
                    },
                    "limit": {
                        "type": "integer",
                        "description": "最多返回几条（默认 50）",
                    },
                },
            },
            executor="backend",
            handler=list_items,
            ack="我看看记忆本～",
        )
    )
    registry.register(
        ToolSpec(
            name="rename_item",
            description=(
                "给记忆本里的条目改名（用户说“把 xx 改名叫 yy / 以后叫它 yy”时调用）。"
                "新名字已被占用时会返回冲突，先问用户换一个。"
            ),
            parameters={
                "type": "object",
                "properties": {
                    "old_name": {"type": "string", "description": "现在的名字"},
                    "new_name": {"type": "string", "description": "新名字（1–30 字）"},
                },
                "required": ["old_name", "new_name"],
            },
            executor="backend",
            handler=rename_item,
            ack="好，改好啦～",
        )
    )
    registry.register(
        ToolSpec(
            name="delete_item",
            description=(
                "只从记忆本删除**记录**，不删除磁盘上的任何文件/文件夹。"
                "用户说“忘掉 / 别记了 / 从记忆本删掉 / 不要这条了”时调用；"
                "names 是要删的名字数组。如果用户说的是“把某个文件夹删了”，"
                "不要用本工具——用 delete_path（会弹确认气泡）。路径条目只说“删掉 X”"
                "时先问清楚是删记录还是删文件，不要猜。"
            ),
            parameters={
                "type": "object",
                "properties": {
                    "names": {
                        "type": "array",
                        "minItems": 1,
                        "maxItems": 10,
                        "items": {"type": "string"},
                        "description": "要删的记忆本条目名（用户话里明确提到的名字）",
                    }
                },
                "required": ["names"],
            },
            executor="backend",
            handler=delete_item,
            needs_user_text=True,
            ack="好，已经忘掉啦～",
        )
    )
    registry.register(
        ToolSpec(
            name="open_item",
            description=(
                "打开记忆本里的条目，或用户本轮消息里给出的网页链接。"
                "优先传 name（记忆本条目名，如“博客”）；用户临时给了一个 http/https "
                "链接时传 url。打开本机文件/文件夹只支持记忆本里已保存的条目。"
                "不要猜名字、不要改写链接；找不到就调用 list_items 或问用户。"
            ),
            parameters={
                "type": "object",
                "properties": {
                    "name": {"type": "string", "description": "记忆本里的条目名"},
                    "url": {
                        "type": "string",
                        "description": "临时链接（必须出现在用户本轮消息里）",
                    },
                },
            },
            executor="frontend",
            prepare=lambda args, user_text: notebook.prepare_open(args, user_text),
            ack="好，帮你打开～",
        )
    )
    registry.register(
        ToolSpec(
            name="delete_path",
            description=(
                "删除本机真实存在的文件或文件夹（会先弹「删除 / 取消」确认气泡，"
                "用户点删除后移入系统回收站，可恢复）。**只用于用户明确要求删除磁盘上的"
                "文件/文件夹时**；只删记忆本记录请用 delete_item。参数 name（记忆本里的"
                "路径条目名）或 path（用户本轮消息里给出的绝对路径），二选一。"
                "路径条目只说“删掉 X”时先问清楚是删记录还是删文件。"
            ),
            parameters={
                "type": "object",
                "properties": {
                    "name": {"type": "string", "description": "记忆本里的路径条目名"},
                    "path": {
                        "type": "string",
                        "description": "用户本轮消息里明确给出的绝对路径",
                    },
                },
            },
            executor="frontend",
            prepare=lambda args, user_text: notebook.prepare_delete_path(args, user_text),
            ack="好，我先跟你确认一下～",
        )
    )

