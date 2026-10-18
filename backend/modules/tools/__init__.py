"""工具机制域（§4.7）：内置工具的注册、协议转换与快通道指令词表。

- ``registry.py``   ← ToolSpec / ToolRegistry（注册表 + OpenAI 协议转换）
- ``builtin.py``    ← build_default_registry（内置工具注册）
- ``directives.py`` ← match_directive（指令词表快通道）

依赖约定：本域不 import llm / application 域——工具定义只描述"是什么"，
"何时发给模型、执行结果如何处理"由 application 层编排（llm 域只收 dict 列表）。
"""

from backend.modules.tools.builtin import build_default_registry
from backend.modules.tools.directives import match_directive, match_forced_tool
from backend.modules.tools.registry import ToolRegistry, ToolSpec

__all__ = [
    "ToolRegistry",
    "ToolSpec",
    "build_default_registry",
    "match_directive",
    "match_forced_tool",
]
