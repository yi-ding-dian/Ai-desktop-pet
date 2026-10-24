"""本地磁盘容量（跳过网络盘/光驱，避免无响应）。"""

from __future__ import annotations

import shutil

from backend.modules.disk.report.models import DriveUsage


def windows_drives() -> list[DriveUsage]:
    """本地固定/可移动磁盘（跳过网络盘、光驱，避免卡住）。"""
    try:
        import ctypes

        kernel32 = ctypes.windll.kernel32
        kernel32.GetLogicalDrives.restype = ctypes.c_uint32
        kernel32.GetDriveTypeW.argtypes = [ctypes.c_wchar_p]
        kernel32.GetDriveTypeW.restype = ctypes.c_uint
        mask = kernel32.GetLogicalDrives()
    except Exception:
        mask = 0
    if not mask:
        return drive_usage_for("C:\\", "C:")

    drives: list[DriveUsage] = []
    for index in range(26):
        if not mask & (1 << index):
            continue
        root = f"{chr(65 + index)}:\\"
        try:
            drive_type = kernel32.GetDriveTypeW(root)
        except Exception:
            drive_type = 0
        # 2=可移动, 3=本地固定；网络盘(4)/光驱(5) 不扫，避免无响应
        if drive_type not in (2, 3):
            continue
        drives.extend(drive_usage_for(root, f"{chr(65 + index)}:"))
    return drives


def drive_usage_for(root: str, label: str) -> list[DriveUsage]:
    try:
        usage = shutil.disk_usage(root)
    except OSError:
        return []
    if usage.total <= 0:
        return []
    return [
        DriveUsage(
            label=label,
            total=int(usage.total),
            used=int(usage.used),
            free=int(usage.free),
        )
    ]


def posix_drives() -> list[DriveUsage]:
    return drive_usage_for("/", "/")
