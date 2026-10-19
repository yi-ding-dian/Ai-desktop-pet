"""记忆本 system 注入格式（2026-10-18）。

只把**名字 + 类型**注入模型上下文；链接 URL 与本机路径**不注入**：

- 打开时模型只传 name，后端按名字取精确值，模型没有机会抄错长链接/路径；
- 少把本机路径（可能含用户名）发给云端 LLM；
- 省 token——记忆本条目可以很多，值可以很长。

``text`` 类型的值例外：它本来就是让宠物"想起来并告诉用户"的内容，所以注入
值（截断到 120 字）。需要链接/路径的原文时，模型调用 ``list_items``，
由后端通知把值展示给用户。
"""

from __future__ import annotations

from typing import Sequence

from backend.modules.memory_book.store import SavedItem

#: 单次注入的条目上限（超出部分只告诉模型"还有 N 条"，打开仍可按名字进行）
MAX_INJECT_ITEMS = 50
#: 注入块总字符上限（防极端情况下撑爆 system prompt）
MAX_INJECT_CHARS = 2000
#: 文本类条目注入值的截断长度
TEXT_VALUE_PREVIEW = 120

_HEADER = (
    "[记忆本] 用户明确让你记住的条目（本地清单）。需要打开时调用 open_item 并传 name；"
    "条目类型是“程序”时，用户说“运行/打开”就用 run_program 并传这个 name。"
    "不要改写条目里的值，也不要把链接/路径念错。用户问某个条目的具体地址/内容时调用 list_items。"
    "不要主动逐条复述清单，除非用户问起。"
)


def _line(item: SavedItem) -> str:
    if item.kind == "text":
        value = " ".join(item.value.split())[:TEXT_VALUE_PREVIEW]
        return f"- {item.name}（文字）：{value}"
    return f"- {item.name}（{item.kind_label}）"


def build_memory_book_block(
    items: Sequence[SavedItem],
    *,
    max_items: int = MAX_INJECT_ITEMS,
    max_chars: int = MAX_INJECT_CHARS,
) -> str | None:
    """组装记忆本注入 system 文本；没有条目返回 None（不注入）。"""
    if not items:
        return None

    lines = [_HEADER, ""]
    used = 0
    included = 0
    for item in items:
        line = _line(item)
        if included >= max_items or used + len(line) + 1 > max_chars:
            break
        lines.append(line)
        used += len(line) + 1
        included += 1

    remaining = len(items) - included
    if remaining > 0:
        lines.append(f"（还有 {remaining} 条未列出；按名字打开/查询仍然有效）")
    return "\n".join(lines)
