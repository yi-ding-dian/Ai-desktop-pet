"""磁盘体检（只读）：容量 + 白名单临时/缓存目录占用。

**只做读取统计，不删除、不写文件、不执行命令。** 用户问“C 盘还有多少空间 /
磁盘满了 / 哪些能清理”时，由 ``disk_report`` 工具调用本模块。

安全与性能边界：
- 只扫描白名单位置（临时目录、已知浏览器缓存、回收站、下载、系统大文件），
  不遍历整盘、不跟随符号链接/junction；
- 每个目录有文件数与耗时上限，超限标记 ``truncated``（报告里显示“≥”）；
- ``WinSxS`` / ``Windows\\Installer`` / ``pagefile.sys`` / ``hiberfil.sys`` 只报
  占用并注明“不要手动删除”，清理建议交给系统工具（磁盘清理 / DISM）；
- 返回给模型的路径用 ``%TEMP%`` 等环境变量形式，避免把用户名写进上下文。

目录内按职责分层：

- ``models.py``         ← 数据模型与字节格式化
- ``scan.py``           ← 目录占用统计与目标累加
- ``targets_windows.py``← Windows 白名单位置
- ``targets_posix.py``  ← POSIX 白名单位置
- ``targets.py``        ← 按平台收集 / 解析可代清理目标
- ``drives.py``         ← 本地磁盘容量
- ``build.py``          ← 一次体检的编排（总预算）
- ``render.py``         ← 报告文本渲染（路径脱敏）
"""

from backend.modules.disk.report.build import build_disk_report
from backend.modules.disk.report.models import (
    CleanupTarget,
    DiskReport,
    DriveUsage,
    format_bytes,
)
from backend.modules.disk.report.render import render_report
from backend.modules.disk.report.scan import directory_size
from backend.modules.disk.report.targets import collect_targets, resolve_clean_targets

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
