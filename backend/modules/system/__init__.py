"""只读系统信息域（2026-10-23）：系统信息、目录占用、大文件、启动项/程序/服务/进程。

边界：只读、不执行任意命令、不读写文件内容；所有扫描带时间/条目预算。
"""

from backend.modules.system.info import (
    DriveInfo,
    SystemInfo,
    collect_system_info,
    list_drives,
)
from backend.modules.system.scan import (
    DirUsage,
    FileUsage,
    largest_files,
    resolve_directory,
    top_level_usage,
)

__all__ = [
    "DirUsage",
    "DriveInfo",
    "FileUsage",
    "SystemInfo",
    "collect_system_info",
    "largest_files",
    "list_drives",
    "resolve_directory",
    "top_level_usage",
]
