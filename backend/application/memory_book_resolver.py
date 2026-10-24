"""记忆本输入解析：模型参数宽容解析、名字/路径/URL 是否本轮点名、删除意图判定。

这些函数只做"把输入变成可判定的精确值"，不读写数据库里的条目本身；
用例由 ``memory_book_service``（保存/删除）与 ``memory_book_prepare``
（打开/运行/删文件前的确认）负责。
"""

from __future__ import annotations

import difflib
import os
import re
from typing import Any, Iterable

from backend.modules.memory_book import MemoryBookStore

#: 删除意图判定（只用于"路径条目"的歧义保护）
#: “连…一起”必须连着文件/文件夹/目录，否则“连记录一起删”会被误判成删文件。
_FILE_INTENT_RE = re.compile(
    r"(文件|文件夹|目录|磁盘|硬盘|本地|回收站|电脑上|连.{0,8}(?:文件|文件夹|目录).{0,4}一起)"
)
_RECORD_INTENT_RE = re.compile(r"(记录|记忆本|忘掉|别记|不用记|不要记|别存|移除)")


def string_arg(args: dict[str, Any], key: str) -> str:
    """取字符串参数：非字符串按空串（避免 str(None) 变成 "None"）。"""
    value = args.get(key)
    return value.strip() if isinstance(value, str) else ""


def coerce_items(items: Any) -> list[dict[str, Any]]:
    """宽容解析 ``save_item`` 的 items 参数（模型偶尔传对象/字符串）。"""
    if isinstance(items, dict):
        return [items]
    if isinstance(items, str):
        return [{"value": items}]
    if isinstance(items, list):
        return [item for item in items if isinstance(item, dict)]
    return []


def coerce_names(names: Any) -> list[str]:
    """宽容解析 ``delete_item`` 的 names 参数。"""
    if isinstance(names, str):
        values: Iterable[Any] = [names]
    elif isinstance(names, list):
        values = names
    else:
        return []
    result: list[str] = []
    for value in values:
        if isinstance(value, str) and value.strip():
            result.append(value.strip())
    return result


def kind_label(kind: str | None) -> str:
    return {
        "link": "链接",
        "path": "文件/文件夹",
        "text": "文字",
        "program": "程序",
    }.get(kind or "", "")


def not_found_message(store: MemoryBookStore, name: str) -> str:
    """找不到条目时的可展示提示：尽量给出相近名字。"""
    items = store.list_all()
    if not items:
        return "记忆本还是空的。跟小兔说“记住……”就会记在这里。"
    names = [item.name for item in items]
    close = difflib.get_close_matches(name, names, n=3, cutoff=0.4)
    if close:
        return f"记忆本里没有『{name}』，你是不是指：{'、'.join(close)}？"
    preview = "、".join(names[:10])
    more = f" 等 {len(names)} 条" if len(names) > 10 else ""
    return f"记忆本里没有『{name}』。现在有：{preview}{more}。"


def _text_key(text: str) -> str:
    """用户原话归一化（空白压缩 + casefold），用于"是否点名"判定。"""
    return " ".join(str(text or "").split()).casefold()


def _path_key(text: str) -> str:
    """路径比较键：分隔符统一 + Windows 大小写不敏感。"""
    return os.path.normcase(str(text or "").replace("\\", "/"))


def name_mentioned(name: str, user_text: str) -> bool:
    """用户本轮是否点名了这个条目（删除记录的硬保护）。"""
    return _text_key(name) in _text_key(user_text)


def path_mentioned(path: str, user_text: str) -> bool:
    """用户本轮是否明确给出了这个路径（临时路径的硬保护）。

    兼容三种写法：用户原样输入、``~``/环境变量展开后、realpath 解析后
    （例如用户说 ``~/bin/app``，模型传来的是 ``/home/me/bin/app``）。
    """
    raw = str(path or "").strip()
    if not raw:
        return False
    text = _text_key(user_text)
    candidates = {raw}
    try:
        expanded = os.path.expandvars(os.path.expanduser(raw.strip("\"'")))
        candidates.add(expanded)
        candidates.add(os.path.realpath(os.path.abspath(expanded)))
    except (OSError, ValueError):
        pass
    return any(
        _path_key(candidate) in _path_key(user_text) or candidate.casefold() in text
        for candidate in candidates
        if candidate
    )


def url_mentioned(url: str, user_text: str) -> bool:
    """用户本轮消息里是否出现过这个链接。

    允许模型把 ``example.com/x`` 补成 ``https://example.com/x``：除完整 URL
    外再比一次"域名 + 路径 + 查询串"。
    """
    text = _text_key(user_text)
    if url.casefold() in text:
        return True
    try:
        from urllib.parse import urlsplit

        parts = urlsplit(url)
    except ValueError:
        return False
    bare = f"{parts.netloc}{parts.path}"
    if parts.query:
        bare += f"?{parts.query}"
    return bool(bare) and bare.casefold() in text


def path_delete_intent(user_text: str) -> str:
    """判定用户这轮说的是"删记录"还是"删文件"。

    返回 ``record``（只删记录）/ ``file``（删真实文件）/ ``both``（两者都要）/
    ``ambiguous``（没说清——必须先反问）。
    """
    text = str(user_text or "")
    file_intent = bool(_FILE_INTENT_RE.search(text))
    record_intent = bool(_RECORD_INTENT_RE.search(text))
    if record_intent and not file_intent:
        return "record"
    if file_intent and not record_intent:
        return "file"
    if file_intent and record_intent:
        return "both"
    return "ambiguous"
