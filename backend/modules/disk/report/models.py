"""磁盘体检的数据模型与字节格式化。"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class DriveUsage:
    """一个本地磁盘分区的容量。"""

    label: str
    total: int
    used: int
    free: int


@dataclass(frozen=True)
class CleanupTarget:
    """一个候选目录/文件的占用统计。"""

    label: str
    path: str
    size: int
    files: int
    cleanable: bool
    note: str = ""
    truncated: bool = False
    #: 可交给 ``clean_disk`` 清理的稳定 key；空 = 只读提示，不代清理
    key: str = ""
    #: ``dir_contents`` = 清理目录里的内容；``files`` = 只清理 paths 里的文件
    kind: str = "dir_contents"
    #: 实际要处理的绝对路径（path 只用于展示，可能是多个目录的摘要）
    paths: tuple[str, ...] = ()


@dataclass(frozen=True)
class DiskReport:
    """一次磁盘体检的结果。"""

    drives: list[DriveUsage]
    targets: list[CleanupTarget]
    scan_seconds: float = 0.0


def format_bytes(size: int) -> str:
    """字节数 → 人类可读（1.2 GB / 350.0 MB / 12 B）。"""
    value = float(max(0, int(size)))
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if value < 1024 or unit == "TB":
            if unit == "B":
                return f"{int(value)} B"
            return f"{value:.1f} {unit}"
        value /= 1024
    return f"{value:.1f} TB"
