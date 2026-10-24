"""一次只读体检的编排（总耗时有预算上限）。"""

from __future__ import annotations

import os
import sys
import time
from typing import Mapping

from backend.modules.disk.report.drives import posix_drives, windows_drives
from backend.modules.disk.report.models import DiskReport
from backend.modules.disk.report.targets import collect_targets

#: 单次扫描的默认总预算（秒）；超时后后续目录只报已知值/标记截断
DEFAULT_BUDGET_SECONDS = 5.0


def build_disk_report(
    platform_name: str | None = None,
    env: Mapping[str, str] | None = None,
    budget_seconds: float = DEFAULT_BUDGET_SECONDS,
) -> DiskReport:
    """执行一次只读体检；总耗时有预算上限。"""
    platform_name = platform_name or sys.platform
    env = dict(os.environ if env is None else env)
    started = time.monotonic()
    deadline = started + max(0.5, budget_seconds)

    drives = windows_drives() if platform_name == "win32" else posix_drives()
    targets = collect_targets(platform_name, env, deadline)
    return DiskReport(
        drives=drives,
        targets=targets,
        scan_seconds=round(time.monotonic() - started, 2),
    )
