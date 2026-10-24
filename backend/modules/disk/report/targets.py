"""按平台收集白名单位置，并解析出可交给 ``clean_disk`` 的目标。"""

from __future__ import annotations

import os
import sys
import time
from typing import Mapping

from backend.modules.disk.report.models import CleanupTarget
from backend.modules.disk.report.targets_posix import posix_targets
from backend.modules.disk.report.targets_windows import windows_targets


def collect_targets(
    platform_name: str, env: Mapping[str, str], deadline: float
) -> list[CleanupTarget]:
    """按平台收集白名单目录的占用（纯函数；测试可直接调用）。"""
    if platform_name == "win32":
        return windows_targets(env, deadline)
    return posix_targets(env, deadline)


def resolve_clean_targets(
    platform_name: str | None = None,
    env: Mapping[str, str] | None = None,
    budget_seconds: float = 2.0,
) -> list[CleanupTarget]:
    """当前平台可代清理的白名目标（只含带 key 的项）。"""
    platform_name = platform_name or sys.platform
    env = dict(os.environ if env is None else env)
    deadline = time.monotonic() + max(0.5, budget_seconds)
    return [
        item
        for item in collect_targets(platform_name, env, deadline)
        if item.key and item.paths
    ]
