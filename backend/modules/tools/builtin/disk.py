"""磁盘体检工具（只读，2026-10-22）：disk_report / clean_disk。"""

from __future__ import annotations

import asyncio
from typing import Any

from backend.modules.tools.registry import ToolRegistry, ToolSpec


def register_disk_tools(registry: ToolRegistry, disk: Any) -> None:
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
