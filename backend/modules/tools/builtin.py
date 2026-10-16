"""内置工具集：``build_default_registry`` 装配本产品的全部内置工具。

新增内置工具时：在本文件追加 ``register(ToolSpec(...))``，并同步
``prompts/capabilities.md`` 的能力清单（模型据此知道何时调用）。
"""

from __future__ import annotations

from backend.modules.tools.registry import ToolRegistry, ToolSpec


def build_default_registry() -> ToolRegistry:
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
    return registry
