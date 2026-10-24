"""内置工具共用的参数读取。"""

from __future__ import annotations

from typing import Any


def string_arg(args: dict[str, Any], key: str) -> str:
    """取字符串参数：非字符串（含 None / 数字）一律按空串——避免 str(None) 变成 "None"。"""
    value = args.get(key)
    return value.strip() if isinstance(value, str) else ""
