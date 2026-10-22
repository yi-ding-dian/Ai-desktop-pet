"""磁盘体检用例（2026-10-22，只读）与清理前置解析。

- ``disk_report``：只读统计，**不删除任何文件**；
- ``clean_disk``：前端型工具，本服务只做“白名单 key + 用户明确要清理”的前置校验，
  真正的删除由主进程再判一次白名单，并在确认气泡后移入回收站。

清理动作永远不接收模型/渲染进程给的任意路径——只接收稳定的白名单 key
（``user_temp`` / ``chrome_cache`` / ...），路径由后端与主进程各自独立解析。
"""

from __future__ import annotations

import asyncio
import re
from typing import Callable

from backend.modules.disk.report import (
    CleanupTarget,
    DiskReport,
    build_disk_report,
    render_report,
    resolve_clean_targets,
)

#: 允许模型请求清理的白名单 key（路径解析在后端/主进程两侧各做一次）
CLEAN_KEYS = frozenset(
    {
        "user_temp",
        "chrome_cache",
        "edge_cache",
        "firefox_cache",
        "thumbnails",
        "user_cache",
        "browser_cache",
    }
)

_CLEAN_INTENT = re.compile(
    r"(清理|清一下|清一清|清了|清掉|清空|删除|删掉|删了|释放空间|腾空间|清缓存|清垃圾)"
)
_CLEAN_NEGATION = re.compile(
    r"(不要|别|先别|不用|暂时不).{0,6}(清理|清一下|清掉|清空|删除|删掉|清缓存)"
)


def cleanup_intent(user_text: str) -> bool:
    """用户本轮是否明确表达了“清理”意图（用于 clean_disk 的授权）。"""
    text = user_text or ""
    if not text or _CLEAN_NEGATION.search(text):
        return False
    return bool(_CLEAN_INTENT.search(text))


class DiskService:
    """磁盘体检 + 清理前置解析（无状态；清理执行在前端/主进程）。"""

    def __init__(
        self,
        builder: Callable[[], DiskReport] = build_disk_report,
        clean_resolver: Callable[[], list[CleanupTarget]] = resolve_clean_targets,
    ) -> None:
        self._builder = builder
        self._clean_resolver = clean_resolver

    def report_from_tool(self) -> dict[str, object]:
        report = self._builder()
        return {
            "ok": True,
            "code": "disk_reported",
            "message": "磁盘情况我看看～",
            "model_content": render_report(report),
        }

    async def prepare_clean(
        self, args: dict[str, object], user_text: str
    ) -> dict[str, object]:
        """``clean_disk`` 的前置解析：白名单 key + 用户原话意图。

        返回的 ``args.targets`` 只含 key；主进程会用自己的白名单重新解析路径并
        再弹确认气泡——这里不返回、也不信任任何绝对路径。
        """
        raw = args.get("targets")
        if not isinstance(raw, list) or not raw:
            return {
                "ok": False,
                "code": "clean_missing",
                "message": "要清理哪些缓存？告诉我需要清的项目。",
            }

        requested: list[str] = []
        for item in raw:
            if not isinstance(item, str):
                return {
                    "ok": False,
                    "code": "clean_bad_target",
                    "message": "清理项目格式不正确。",
                }
            key = item.strip()
            if not key:
                continue
            if key not in CLEAN_KEYS:
                return {
                    "ok": False,
                    "code": "clean_unknown_target",
                    "message": (
                        f"『{key}』不是可代清理的项目。可用："
                        + "、".join(sorted(CLEAN_KEYS))
                    ),
                }
            if key not in requested:
                requested.append(key)
        if not requested:
            return {
                "ok": False,
                "code": "clean_missing",
                "message": "要清理哪些缓存？告诉我需要清的项目。",
            }
        if not cleanup_intent(user_text):
            return {
                "ok": False,
                "code": "clean_not_requested",
                "message": (
                    "你是想清理这些缓存吗？请明确说“清理……”之后，我才会弹确认气泡。"
                ),
            }

        targets = await asyncio.to_thread(self._clean_resolver)
        by_key = {item.key: item for item in targets if item.key}
        missing = [key for key in requested if key not in by_key]
        if missing:
            return {
                "ok": False,
                "code": "clean_target_missing",
                "message": (
                    "这些位置现在没有找到缓存："
                    + "、".join(missing)
                    + "。可能已经被清理过，或者浏览器没有装/没用过。"
                ),
            }
        if sum(by_key[key].size for key in requested) <= 0:
            return {
                "ok": False,
                "code": "clean_empty",
                "message": "这些位置现在是空的，没有需要清理的内容。",
            }

        return {"ok": True, "args": {"targets": requested}}
