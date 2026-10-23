"""只读系统信息（2026-10-23）：系统版本、CPU、内存、开机时长、本地磁盘容量。

不读文件内容、不调用 shell；Windows 用 ctypes 读内存/开机时长，POSIX 读 sysconf 与
/proc/uptime。所有失败都降级为 0/空值，由上层格式化成“未读取到”。
"""

from __future__ import annotations

import ctypes
import os
import platform
import shutil
import sys
from dataclasses import dataclass


@dataclass(frozen=True)
class SystemInfo:
    os_name: str
    os_release: str
    os_version: str
    machine: str
    processor: str
    cpu_count: int
    memory_total: int
    memory_available: int
    uptime_seconds: float


@dataclass(frozen=True)
class DriveInfo:
    label: str
    total: int
    used: int
    free: int


class _MemoryStatusEx(ctypes.Structure):
    _fields_ = [
        ("dwLength", ctypes.c_ulong),
        ("dwMemoryLoad", ctypes.c_ulong),
        ("ullTotalPhys", ctypes.c_ulonglong),
        ("ullAvailPhys", ctypes.c_ulonglong),
        ("ullTotalPageFile", ctypes.c_ulonglong),
        ("ullAvailPageFile", ctypes.c_ulonglong),
        ("ullTotalVirtual", ctypes.c_ulonglong),
        ("ullAvailVirtual", ctypes.c_ulonglong),
        ("ullAvailExtendedVirtual", ctypes.c_ulonglong),
    ]


def _windows_memory() -> tuple[int, int]:
    try:
        kernel32 = ctypes.windll.kernel32
        status = _MemoryStatusEx()
        status.dwLength = ctypes.sizeof(_MemoryStatusEx)
        if not kernel32.GlobalMemoryStatusEx(ctypes.byref(status)):
            return 0, 0
        return int(status.ullTotalPhys), int(status.ullAvailPhys)
    except Exception:
        return 0, 0


def _posix_memory() -> tuple[int, int]:
    try:
        page = int(os.sysconf("SC_PAGE_SIZE"))
        total = int(os.sysconf("SC_PHYS_PAGES")) * page
        available = int(os.sysconf("SC_AVPHYS_PAGES")) * page
        return total, available
    except (ValueError, OSError, AttributeError):
        return 0, 0


def _uptime_seconds() -> float:
    if sys.platform == "win32":
        try:
            kernel32 = ctypes.windll.kernel32
            kernel32.GetTickCount64.restype = ctypes.c_ulonglong
            return float(kernel32.GetTickCount64()) / 1000.0
        except Exception:
            return 0.0
    try:
        with open("/proc/uptime", "r", encoding="ascii") as handle:
            return float(handle.read().split()[0])
    except (OSError, ValueError, IndexError):
        return 0.0


def collect_system_info() -> SystemInfo:
    """采集平台信息；任何字段失败都返回空/0，不抛异常。"""
    memory_total, memory_available = (
        _windows_memory() if sys.platform == "win32" else _posix_memory()
    )
    uname = platform.uname()
    processor = platform.processor() or uname.processor or uname.machine
    try:
        cpu_count = int(os.cpu_count() or 0)
    except Exception:
        cpu_count = 0
    return SystemInfo(
        os_name=f"{uname.system} {uname.release}".strip(),
        os_release=uname.release,
        os_version=uname.version,
        machine=uname.machine,
        processor=processor,
        cpu_count=cpu_count,
        memory_total=memory_total,
        memory_available=memory_available,
        uptime_seconds=_uptime_seconds(),
    )


def _drive_usage(root: str, label: str) -> list[DriveInfo]:
    try:
        usage = shutil.disk_usage(root)
    except OSError:
        return []
    if usage.total <= 0:
        return []
    return [
        DriveInfo(
            label=label,
            total=int(usage.total),
            used=int(usage.used),
            free=int(usage.free),
        )
    ]


def _windows_drives() -> list[DriveInfo]:
    try:
        kernel32 = ctypes.windll.kernel32
        kernel32.GetLogicalDrives.restype = ctypes.c_uint32
        kernel32.GetDriveTypeW.argtypes = [ctypes.c_wchar_p]
        kernel32.GetDriveTypeW.restype = ctypes.c_uint
        mask = kernel32.GetLogicalDrives()
    except Exception:
        return _drive_usage("C:\\", "C:")

    drives: list[DriveInfo] = []
    for index in range(26):
        if not mask & (1 << index):
            continue
        root = f"{chr(65 + index)}:\\"
        try:
            drive_type = kernel32.GetDriveTypeW(root)
        except Exception:
            drive_type = 0
        # 2=可移动, 3=本地固定；网络盘/光驱不扫描（避免无响应）
        if drive_type not in (2, 3):
            continue
        drives.extend(_drive_usage(root, f"{chr(65 + index)}:"))
    return drives


def list_drives() -> list[DriveInfo]:
    """本地固定/可移动磁盘容量；非 Windows 返回根分区。"""
    if sys.platform == "win32":
        return _windows_drives()
    return _drive_usage("/", "/")
