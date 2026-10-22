"""磁盘体检域（只读）：容量 + 常见临时/缓存目录占用。

边界：只读、不删除、不执行命令；扫描范围限定在白名单位置，带时间/文件数预算。
"""

from backend.modules.disk.report import (
    CleanupTarget,
    DiskReport,
    DriveUsage,
    build_disk_report,
    collect_targets,
    directory_size,
    format_bytes,
    render_report,
    resolve_clean_targets,
)

__all__ = [
    "CleanupTarget",
    "DiskReport",
    "DriveUsage",
    "build_disk_report",
    "collect_targets",
    "directory_size",
    "format_bytes",
    "render_report",
    "resolve_clean_targets",
]
