"""记忆本工具（2026-10-18）：保存 / 列出 / 改名 / 删记录 / 打开 / 删路径 / 运行程序。"""

from __future__ import annotations

from typing import Any

from backend.modules.tools.builtin.args import string_arg
from backend.modules.tools.registry import ToolRegistry, ToolSpec


def register_memory_book_tools(registry: ToolRegistry, memory_book: Any) -> None:
    """注册记忆本工具（服务接口见 application/memory_book_service.py）。"""

    def save_item(args: dict[str, Any]) -> dict[str, Any]:
        return memory_book.save_from_tool(args.get("items"))

    def list_items(args: dict[str, Any]) -> dict[str, Any]:
        raw_limit = args.get("limit")
        try:
            limit = int(raw_limit) if raw_limit is not None else 50
        except (TypeError, ValueError):
            limit = 50
        return memory_book.list_from_tool(kind=string_arg(args, "kind") or None, limit=limit)

    def rename_item(args: dict[str, Any]) -> dict[str, Any]:
        return memory_book.rename_from_tool(
            old_name=string_arg(args, "old_name"),
            new_name=string_arg(args, "new_name"),
        )

    def delete_item(args: dict[str, Any], user_text: str) -> dict[str, Any]:
        return memory_book.delete_from_tool(args.get("names"), user_text)

    registry.register(
        ToolSpec(
            name="save_item",
            description=(
                "把用户要求记住的精确条目存到「记忆本」。"
                "用户说“记住 / 收藏”链接、绝对路径、编号/单号，"
                "或明确说“存到记忆本”时调用；偏好、事实、经历不要用本工具。"
                "items 最多 10 条，同名更新；name 可省略（自动起名）。"
                "可执行程序只能由用户在设置里手动添加；不要保存密码/密钥。"
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
                                    "description": "短名字（可省略，自动起名）",
                                },
                                "kind": {
                                    "type": "string",
                                    "enum": ["link", "path", "text"],
                                    "description": "link/path/text（可省略自动判断）",
                                },
                                "value": {
                                    "type": "string",
                                    "description": "完整链接、绝对路径或编号/短文本",
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
                        "enum": ["link", "path", "text", "program"],
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
                "**程序条目不要用本工具**——要运行程序请用 run_program。"
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
            prepare=lambda args, user_text: memory_book.prepare_open(args, user_text),
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
            prepare=lambda args, user_text: memory_book.prepare_delete_path(args, user_text),
            ack="好，我先跟你确认一下～",
        )
    )
    registry.register(
        ToolSpec(
            name="run_program",
            description=(
                "启动本机程序（只启动本体、不带参数，不支持命令/管道）。"
                "用户说“打开 / 运行 / 启动”某个程序或应用时调用。"
                "name 用记忆本登记名或用户原话的应用名，不要翻译或猜测；"
                "path 仅在用户本轮给出绝对路径时传。临时路径会先弹确认气泡。"
            ),
            parameters={
                "type": "object",
                "properties": {
                    "name": {
                        "type": "string",
                        "description": "记忆本程序名或用户原话的应用名（不要改写）",
                    },
                    "path": {
                        "type": "string",
                        "description": "用户本轮给出的可执行文件绝对路径",
                    },
                },
            },
            executor="frontend",
            prepare=lambda args, user_text: memory_book.prepare_run_program(
                args, user_text
            ),
            ack="好，我去启动～",
        )
    )
