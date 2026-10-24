"""只读系统巡检工具（2026-10-23）：inspect_system（backend + feedback）。"""

from __future__ import annotations

import asyncio
from typing import Any

from backend.modules.tools.registry import ToolRegistry, ToolSpec


def register_system_tools(registry: ToolRegistry, system: Any) -> None:
    """注册只读系统巡检工具（handler 放线程池，避免阻塞事件循环）。"""

    async def inspect_system(args: dict[str, Any]) -> dict[str, Any]:
        return await asyncio.to_thread(system.inspect_from_tool, args)

    registry.register(
        ToolSpec(
            name="inspect_system",
            description=(
                "只读查看本机系统信息：系统配置、磁盘容量、目录占用、最大文件、"
                "启动项、已安装程序、服务、进程。不执行任意命令、不读写文件正文、"
                "不 kill 进程、不启停服务。用户问“电脑配置/启动项/装了什么/"
                "哪些服务在跑/哪个文件夹大/最大的文件”时调用。"
                "top_dirs/largest_files 的 path 必须是本地绝对目录；limit 默认 10。"
            ),
            parameters={
                "type": "object",
                "properties": {
                    "op": {
                        "type": "string",
                        "enum": [
                            "system_info",
                            "drives",
                            "top_dirs",
                            "largest_files",
                            "startup_items",
                            "installed_apps",
                            "services",
                            "processes",
                        ],
                    },
                    "path": {
                        "type": "string",
                        "description": (
                            "top_dirs / largest_files 的本地绝对目录；"
                            "其他 op 忽略"
                        ),
                    },
                    "limit": {
                        "type": "integer",
                        "minimum": 1,
                        "maximum": 50,
                        "description": "返回条数，默认 10",
                    },
                },
                "required": ["op"],
            },
            executor="backend",
            handler=inspect_system,
            feedback=True,
            ack="好，我看看～",
        )
    )
