"""内置工具集：``build_default_registry`` 装配本产品的全部内置工具。

新增内置工具时：在本文件追加 ``register(ToolSpec(...))``，并同步
``prompts/capabilities.md`` 的能力清单（模型据此知道何时调用）。

可选注入（不传时注册表与旧版一致，避免模块间硬依赖）：

- ``reminders``（2026-10-18）：提醒服务（application 层实现）——注册
  create_reminder / list_reminders / cancel_reminder 三个 **backend 型**工具；
- ``memory_book``（2026-10-18）：记忆本服务（application 层实现）——注册
  save_item / list_items / rename_item / delete_item / open_item / delete_path。
  ``open_item`` / ``delete_path`` 是 **frontend 型**，但带 ``prepare``：
  模型只传名字，chat 管道派发前由后端解析成精确值并校验用户本轮原话；
  ``delete_path`` 到前端后还要弹确认气泡，用户点「删除」才由主进程移入回收站。
- ``search``（2026-10-18）：联网搜索服务（application 层实现）——注册
  web_search / web_fetch 两个 **backend 型 + feedback** 工具：结果会回喂给模型，
  由 chat 管道再跑一轮 LLM 生成最终回答（搜索/抓取由 DeepSeek 官方接口提供）。
- ``disk``（2026-10-22）：磁盘体检/清理服务（application 层实现）——注册
  disk_report（backend + feedback，只读）与 clean_disk（frontend + prepare，
  只传白名单 key，实际清理在主进程确认气泡后移入回收站）。
"""

from __future__ import annotations

import asyncio
from typing import Any

from backend.modules.tools.registry import ToolRegistry, ToolSpec


def build_default_registry(
    reminders: Any | None = None,
    memory_book: Any | None = None,
    search: Any | None = None,
    disk: Any | None = None,
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
    registry.register(
        ToolSpec(
            name="open_work",
            description=(
                "打开工作模式聊天窗（完整对话记录、历史导航、深度思考/联网搜索开关；"
                "用户想展开长对话、回看历史或认真处理一件事时使用）"
            ),
            parameters={"type": "object", "properties": {}},
            executor="frontend",
            ack="好，工作台给你打开啦~",
        )
    )
    if reminders is not None:
        _register_reminder_tools(registry, reminders)
    if memory_book is not None:
        _register_memory_book_tools(registry, memory_book)
    if search is not None:
        _register_search_tools(registry, search)
    if disk is not None:
        _register_disk_tools(registry, disk)
    return registry


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


# ---------------------------------------------------------------- 记忆本（2026-10-18）


def _register_memory_book_tools(registry: ToolRegistry, memory_book: Any) -> None:
    """注册记忆本工具（服务接口见 application/memory_book_service.py）。"""

    def save_item(args: dict[str, Any]) -> dict[str, Any]:
        return memory_book.save_from_tool(args.get("items"))

    def list_items(args: dict[str, Any]) -> dict[str, Any]:
        raw_limit = args.get("limit")
        try:
            limit = int(raw_limit) if raw_limit is not None else 50
        except (TypeError, ValueError):
            limit = 50
        return memory_book.list_from_tool(kind=_string_arg(args, "kind") or None, limit=limit)

    def rename_item(args: dict[str, Any]) -> dict[str, Any]:
        return memory_book.rename_from_tool(
            old_name=_string_arg(args, "old_name"),
            new_name=_string_arg(args, "new_name"),
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


# ---------------------------------------------------------------- 联网搜索（2026-10-18）


def _register_search_tools(registry: ToolRegistry, search: Any) -> None:
    """注册联网搜索工具（服务接口见 application/search_service.py）。

    结果通过 ``feedback=True`` 回喂给模型：chat 管道先执行工具，再把搜索结果
    作为 tool 消息追加到上下文，跑第二轮 LLM 生成最终回答。
    """

    async def web_search(args: dict[str, Any], user_text: str) -> dict[str, Any]:
        return await search.search_from_tool(args, user_text)

    async def web_fetch(args: dict[str, Any]) -> dict[str, Any]:
        return await search.fetch_from_tool(args)

    registry.register(
        ToolSpec(
            name="web_search",
            description=(
                "联网搜索实时网页（DeepSeek Search）。用户问最新/今天/最近/实时/"
                "新闻/价格/天气/版本发布等当前信息，或明确说“搜一下/查一下/搜索”时调用。"
                "query 用简洁关键词（1–128 字，支持 site: / -site: / \"精确短语\" / "
                "after: / before: 等语法）；不要搜索用户隐私或本地文件内容。"
                "搜索结果会返回给你阅读；回答时用 [1][2] 标注来源，并在末尾列出"
                "用到的标题与 URL。结果条数由用户设置决定，不要自己指定。"
            ),
            parameters={
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "搜索关键词（1–128 字）",
                    }
                },
                "required": ["query"],
            },
            executor="backend",
            handler=web_search,
            needs_user_text=True,
            feedback=True,
            ack="我搜一下～",
        )
    )
    registry.register(
        ToolSpec(
            name="web_fetch",
            description=(
                "抓取一个 http/https 网页并读取 Markdown 正文（DeepSeek Fetch）。"
                "用户给出具体链接并让你看看/总结/读一下，或搜索结果里的页面需要"
                "细读时调用。不要抓取需要登录、明显私密或本机/内网的地址。"
                "抓到的正文会返回给你阅读；回答时注明本页标题与 URL。"
            ),
            parameters={
                "type": "object",
                "properties": {
                    "url": {
                        "type": "string",
                        "description": "要读取的网页地址（http/https）",
                    }
                },
                "required": ["url"],
            },
            executor="backend",
            handler=web_fetch,
            feedback=True,
            ack="我看看这个网页～",
        )
    )


# ---------------------------------------------------------------- 磁盘体检（只读，2026-10-22）


def _register_disk_tools(registry: ToolRegistry, disk: Any) -> None:
    """注册只读磁盘体检工具（handler 放线程池，避免阻塞事件循环）。"""

    async def disk_report(args: dict[str, Any]) -> dict[str, Any]:
        return await asyncio.to_thread(disk.report_from_tool)

    async def prepare_clean(
        args: dict[str, Any], user_text: str
    ) -> dict[str, Any]:
        return await disk.prepare_clean(args, user_text)

    registry.register(
        ToolSpec(
            name="disk_report",
            description=(
                "只读查看本机各磁盘容量和常见临时/缓存目录占用，给出可清理建议。"
                "用户问“C 盘还有多少空间 / 磁盘满了 / 哪些数据可以清理”时调用。"
                "本工具不会删除任何文件；清理建议让用户自己确认操作。"
            ),
            parameters={"type": "object", "properties": {}},
            executor="backend",
            handler=disk_report,
            feedback=True,
            ack="好，我看看磁盘～",
        )
    )
    registry.register(
        ToolSpec(
            name="clean_disk",
            description=(
                "清理磁盘缓存/临时目录（只处理 disk_report 返回的白名单 key）。"
                "会先弹「清理 / 取消」确认气泡，用户点清理后才把内容移入回收站"
                "（可恢复；正在使用的文件会跳过）。只有用户明确要求清理时才调用；"
                "用户点确认前不要说已经清理完。"
            ),
            parameters={
                "type": "object",
                "properties": {
                    "targets": {
                        "type": "array",
                        "items": {
                            "type": "string",
                            "enum": [
                                "user_temp",
                                "chrome_cache",
                                "edge_cache",
                                "firefox_cache",
                                "thumbnails",
                                "user_cache",
                                "browser_cache",
                            ],
                        },
                        "minItems": 1,
                        "maxItems": 7,
                        "description": (
                            "要清理的缓存 key，必须来自 disk_report 的"
                            "「小兔可代清理」列表；不要自己编路径"
                        ),
                    }
                },
                "required": ["targets"],
            },
            executor="frontend",
            prepare=prepare_clean,
            ack="好，我先跟你确认一下～",
        )
    )
