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
"""

from __future__ import annotations

import os
import shutil
import stat
import sys
import tempfile
import time
from dataclasses import dataclass
from typing import Callable, Iterable, Mapping, Sequence

#: 单次扫描的默认总预算（秒）；超时后后续目录只报已知值/标记截断
DEFAULT_BUDGET_SECONDS = 5.0

#: 单个目录最多遍历的条目数（防止用户目录里有几十万文件）
MAX_ENTRIES_PER_DIR = 200_000

#: 单个目录的默认扫描上限（秒）
DEFAULT_DIR_CAP_SECONDS = 1.0


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


def directory_size(
    path: str,
    *,
    deadline: float,
    max_entries: int = MAX_ENTRIES_PER_DIR,
    name_filter: Callable[[str], bool] | None = None,
) -> tuple[int, int, bool]:
    """统计目录占用（不跟随符号链接）。

    返回 ``(bytes, files, truncated)``；``files`` 只统计被计入的文件
    （``name_filter`` 过滤时不含未命中文件）。时间/条目超限时 ``truncated=True``。
    """
    total = 0
    files = 0
    entries = 0
    truncated = False
    stack = [path]

    while stack:
        if time.monotonic() >= deadline or entries >= max_entries:
            truncated = True
            break
        current = stack.pop()
        try:
            iterator = os.scandir(current)
        except OSError:
            continue
        with iterator:
            for entry in iterator:
                entries += 1
                if entries >= max_entries or time.monotonic() >= deadline:
                    truncated = True
                    break
                try:
                    if entry.is_dir(follow_symlinks=False):
                        # Windows junction 可能指回祖先：跳过，避免环
                        is_junction = getattr(entry, "is_junction", None)
                        if is_junction is not None and is_junction():
                            continue
                        stack.append(entry.path)
                    elif entry.is_file(follow_symlinks=False):
                        if name_filter is not None and not name_filter(entry.name):
                            continue
                        total += entry.stat(follow_symlinks=False).st_size
                        files += 1
                except OSError:
                    continue
        if truncated:
            break

    return total, files, truncated


def _existing_dir(path: str | None) -> str:
    if not path:
        return ""
    try:
        return path if os.path.isdir(path) else ""
    except OSError:
        return ""


def _add_dir_target(
    targets: list[CleanupTarget],
    label: str,
    path: str | None,
    *,
    cleanable: bool,
    note: str,
    deadline: float,
    cap_seconds: float = DEFAULT_DIR_CAP_SECONDS,
    name_filter: Callable[[str], bool] | None = None,
    key: str = "",
) -> None:
    directory = _existing_dir(path)
    if not directory:
        return
    size, files, truncated = directory_size(
        directory,
        deadline=min(deadline, time.monotonic() + cap_seconds),
        name_filter=name_filter,
    )
    targets.append(
        CleanupTarget(
            label=label,
            path=directory,
            size=size,
            files=files,
            cleanable=cleanable,
            note=note,
            truncated=truncated,
            key=key,
            kind="dir_contents",
            paths=(directory,),
        )
    )


def _add_multi_dir_target(
    targets: list[CleanupTarget],
    label: str,
    paths: Iterable[str],
    *,
    cleanable: bool,
    note: str,
    deadline: float,
    cap_per_dir: float = 0.4,
    key: str = "",
) -> None:
    directories = [item for item in (_existing_dir(path) for path in paths) if item]
    if not directories:
        return
    total = 0
    files = 0
    truncated = False
    for directory in directories:
        if time.monotonic() >= deadline:
            truncated = True
            break
        size, count, cut = directory_size(
            directory,
            deadline=min(deadline, time.monotonic() + cap_per_dir),
        )
        total += size
        files += count
        truncated = truncated or cut
    targets.append(
        CleanupTarget(
            label=label,
            path="、".join(directories[:3]) + (" 等" if len(directories) > 3 else ""),
            size=total,
            files=files,
            cleanable=cleanable,
            note=note,
            truncated=truncated,
            key=key,
            kind="dir_contents",
            paths=tuple(directories),
        )
    )


def _add_file_target(
    targets: list[CleanupTarget],
    label: str,
    path: str | None,
    *,
    cleanable: bool,
    note: str,
    key: str = "",
) -> None:
    if not path:
        return
    try:
        info = os.stat(path)
    except OSError:
        return
    if not stat.S_ISREG(info.st_mode):
        return
    targets.append(
        CleanupTarget(
            label=label,
            path=path,
            size=info.st_size,
            files=1,
            cleanable=cleanable,
            note=note,
            key=key,
            kind="files",
            paths=(path,),
        )
    )


def _add_file_list_target(
    targets: list[CleanupTarget],
    label: str,
    files: Iterable[str],
    display_path: str,
    *,
    cleanable: bool,
    note: str,
    key: str = "",
) -> None:
    """多个文件合并成一个目标（缩略图缓存这种同目录散文件）。"""
    existing: list[str] = []
    total = 0
    for item in files:
        try:
            info = os.stat(item)
        except OSError:
            continue
        if not stat.S_ISREG(info.st_mode):
            continue
        existing.append(item)
        total += info.st_size
    if not existing:
        return
    targets.append(
        CleanupTarget(
            label=label,
            path=display_path,
            size=total,
            files=len(existing),
            cleanable=cleanable,
            note=note,
            key=key,
            kind="files",
            paths=tuple(existing),
        )
    )


def _profile_dirs(root: str, suffixes: Sequence[str]) -> list[str]:
    """``root\\<profile>\\<suffix>``（浏览器缓存目录，只看已存在的 profile）。"""
    result: list[str] = []
    if not root or not os.path.isdir(root):
        return result
    try:
        profiles = [entry.path for entry in os.scandir(root) if entry.is_dir()]
    except OSError:
        return result
    for profile in profiles:
        for suffix in suffixes:
            candidate = os.path.join(profile, suffix)
            if os.path.isdir(candidate):
                result.append(candidate)
    return result


def _windows_message_paths(env: Mapping[str, str]) -> dict[str, str]:
    local = env.get("LOCALAPPDATA", "")
    roaming = env.get("APPDATA", "")
    profile = env.get("USERPROFILE", "")
    windir = env.get("SystemRoot") or env.get("WINDIR") or r"C:\Windows"
    temp = env.get("TEMP") or env.get("TMP") or tempfile.gettempdir()
    drive = env.get("SystemDrive") or "C:"
    return {
        "local": local,
        "roaming": roaming,
        "profile": profile,
        "windir": windir,
        "temp": temp,
        "system_drive": drive.rstrip("\\/") + "\\",
    }


def _windows_targets(
    env: Mapping[str, str], deadline: float
) -> list[CleanupTarget]:
    paths = _windows_message_paths(env)
    local = paths["local"]
    profile = paths["profile"]
    windir = paths["windir"]
    system_drive = paths["system_drive"]
    targets: list[CleanupTarget] = []

    # ---- 可清理：临时文件 / 更新缓存 / 浏览器缓存 ----
    temp_name = os.path.basename(os.path.normpath(paths["temp"])).lower()
    _add_dir_target(
        targets,
        "用户临时文件",
        paths["temp"],
        cleanable=True,
        note="正在使用的文件会被跳过；可在系统「存储感知」/磁盘清理里勾选删除。",
        deadline=deadline,
        key="user_temp" if temp_name in ("temp", "tmp") else "",
    )
    _add_dir_target(
        targets,
        "系统临时文件",
        os.path.join(windir, "Temp"),
        cleanable=True,
        note="部分文件被系统占用；建议用磁盘清理，不要强行删除。",
        deadline=deadline,
    )
    _add_dir_target(
        targets,
        "Windows 更新下载缓存",
        os.path.join(windir, "SoftwareDistribution", "Download"),
        cleanable=True,
        note="Windows 更新的下载缓存；用系统「磁盘清理」清理最稳妥。",
        deadline=deadline,
    )
    explorer = os.path.join(local, "Microsoft", "Windows", "Explorer")
    thumb_files: list[str] = []
    if os.path.isdir(explorer):
        try:
            thumb_files = [
                os.path.join(explorer, name)
                for name in os.listdir(explorer)
                if name.lower().startswith(("thumbcache_", "iconcache_"))
            ]
        except OSError:
            thumb_files = []
    _add_file_list_target(
        targets,
        "缩略图/图标缓存",
        thumb_files,
        explorer,
        cleanable=True,
        note="资源管理器会自动重建；只处理 thumbcache/iconcache 文件。",
        key="thumbnails",
    )
    if local:
        chrome = _profile_dirs(
            os.path.join(local, "Google", "Chrome", "User Data"),
            ("Cache", "Code Cache", "GPUCache", os.path.join("Service Worker", "CacheStorage")),
        )
        _add_multi_dir_target(
            targets,
            "Chrome 缓存",
            chrome,
            cleanable=True,
            note="浏览器缓存；更稳妥的是在 Chrome「清除浏览数据」里清理。",
            deadline=deadline,
            key="chrome_cache",
        )
        edge = _profile_dirs(
            os.path.join(local, "Microsoft", "Edge", "User Data"),
            ("Cache", "Code Cache", "GPUCache", os.path.join("Service Worker", "CacheStorage")),
        )
        _add_multi_dir_target(
            targets,
            "Edge 缓存",
            edge,
            cleanable=True,
            note="浏览器缓存；更稳妥的是在 Edge「清除浏览数据」里清理。",
            deadline=deadline,
            key="edge_cache",
        )
        firefox: list[str] = []
        profiles_root = os.path.join(local, "Mozilla", "Firefox", "Profiles")
        if os.path.isdir(profiles_root):
            try:
                firefox = [
                    os.path.join(entry.path, "cache2")
                    for entry in os.scandir(profiles_root)
                    if entry.is_dir() and os.path.isdir(os.path.join(entry.path, "cache2"))
                ]
            except OSError:
                firefox = []
        _add_multi_dir_target(
            targets,
            "Firefox 缓存",
            firefox,
            cleanable=True,
            note="浏览器缓存；可在 Firefox「清除最近的历史记录」里清理。",
            deadline=deadline,
            key="firefox_cache",
        )

    # ---- 需要用户确认：回收站 / 下载 ----
    _add_dir_target(
        targets,
        "回收站",
        os.path.join(system_drive, "$Recycle.Bin"),
        cleanable=False,
        note="清空回收站才会释放；请用桌面回收站或系统「存储感知」。",
        deadline=deadline,
        cap_seconds=0.5,
    )
    _add_dir_target(
        targets,
        "下载文件夹",
        os.path.join(profile, "Downloads") if profile else "",
        cleanable=False,
        note="这里是你的个人文件，按需自行整理，小兔不会自动清理。",
        deadline=deadline,
        cap_seconds=0.5,
    )

    # ---- 不要手动删：系统大文件/组件 ----
    _add_file_target(
        targets,
        "休眠文件",
        os.path.join(system_drive, "hiberfil.sys"),
        cleanable=False,
        note="不用休眠时可在管理员终端执行 powercfg /h off；不要直接删文件。",
    )
    _add_file_target(
        targets,
        "分页文件",
        os.path.join(system_drive, "pagefile.sys"),
        cleanable=False,
        note="系统虚拟内存文件，由 Windows 管理；不要删除。",
    )
    _add_dir_target(
        targets,
        "WinSxS（组件存储）",
        os.path.join(windir, "WinSxS"),
        cleanable=False,
        note="严禁手动删除；需要清理请用 DISM /Online /Cleanup-Image /StartComponentCleanup。",
        deadline=deadline,
        cap_seconds=0.8,
    )
    _add_dir_target(
        targets,
        "Windows Installer 缓存",
        os.path.join(windir, "Installer"),
        cleanable=False,
        note="卸载/修复程序需要，不要删除。",
        deadline=deadline,
        cap_seconds=0.5,
    )
    _add_dir_target(
        targets,
        "旧系统备份 Windows.old",
        os.path.join(system_drive, "Windows.old"),
        cleanable=False,
        note="请用系统「磁盘清理」删除，不要手动删。",
        deadline=deadline,
        cap_seconds=0.5,
    )
    _add_dir_target(
        targets,
        "安装包缓存 Package Cache",
        os.path.join(local, "Package Cache") if local else "",
        cleanable=False,
        note="修复/卸载程序可能要用；不建议手动清空。",
        deadline=deadline,
        cap_seconds=0.5,
    )

    return targets


def _posix_targets(env: Mapping[str, str], deadline: float) -> list[CleanupTarget]:
    home = env.get("HOME") or os.path.expanduser("~")
    cache = env.get("XDG_CACHE_HOME") or os.path.join(home, ".cache")
    targets: list[CleanupTarget] = []
    _add_dir_target(
        targets,
        "用户缓存目录",
        cache,
        cleanable=True,
        note="应用缓存；正在使用的文件会被跳过。",
        deadline=deadline,
        key="user_cache",
    )
    _add_dir_target(
        targets,
        "系统临时目录",
        "/tmp",
        cleanable=True,
        note="重启后通常会自动清理；正在使用的文件不要删。",
        deadline=deadline,
    )
    _add_dir_target(
        targets,
        "回收站",
        os.path.join(home, ".local", "share", "Trash"),
        cleanable=False,
        note="清空回收站才会释放；请用文件管理器清空。",
        deadline=deadline,
        cap_seconds=0.5,
    )
    _add_dir_target(
        targets,
        "下载文件夹",
        os.path.join(home, "Downloads"),
        cleanable=False,
        note="个人文件，按需自行整理。",
        deadline=deadline,
        cap_seconds=0.5,
    )
    _add_multi_dir_target(
        targets,
        "浏览器缓存",
        [
            os.path.join(cache, "google-chrome"),
            os.path.join(cache, "microsoft-edge"),
            os.path.join(cache, "mozilla", "firefox"),
        ],
        cleanable=True,
        note="浏览器缓存；更稳妥的是在浏览器设置里清理。",
        deadline=deadline,
        key="browser_cache",
    )
    return targets


def collect_targets(
    platform_name: str, env: Mapping[str, str], deadline: float
) -> list[CleanupTarget]:
    """按平台收集白名单目录的占用（纯函数；测试可直接调用）。"""
    if platform_name == "win32":
        return _windows_targets(env, deadline)
    return _posix_targets(env, deadline)


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


def _windows_drives() -> list[DriveUsage]:
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
        return _drive_usage_for("C:\\", "C:")

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
        drives.extend(_drive_usage_for(root, f"{chr(65 + index)}:"))
    return drives


def _drive_usage_for(root: str, label: str) -> list[DriveUsage]:
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


def _posix_drives() -> list[DriveUsage]:
    return _drive_usage_for("/", "/")


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

    drives = _windows_drives() if platform_name == "win32" else _posix_drives()
    targets = collect_targets(platform_name, env, deadline)
    return DiskReport(
        drives=drives,
        targets=targets,
        scan_seconds=round(time.monotonic() - started, 2),
    )


def _display_path(path: str, env: Mapping[str, str]) -> str:
    """把用户目录前缀换成环境变量形式，避免把用户名写进模型上下文。"""
    if not path:
        return ""
    rendered: list[str] = []
    # 多目录用“、”拼接：逐个替换，否则只有第一个路径会脱敏
    for part in path.split("、"):
        text = part
        for key in (
            "TEMP",
            "TMP",
            "LOCALAPPDATA",
            "APPDATA",
            "USERPROFILE",
            "SystemRoot",
            "WINDIR",
            "HOME",
        ):
            value = env.get(key)
            if not value:
                continue
            if text.lower().startswith(value.lower()):
                text = f"%{key}%" + text[len(value):]
                break
        rendered.append(text)
    text = "、".join(rendered)
    if len(text) > 160:
        text = text[:157] + "..."
    return text


def _percent(used: int, total: int) -> int:
    if total <= 0:
        return 0
    return int(round(used * 100 / total))


def render_report(
    report: DiskReport,
    env: Mapping[str, str] | None = None,
) -> str:
    """把报告渲染成给模型看的紧凑文本（不含用户名全路径）。"""
    env = dict(os.environ if env is None else env)
    lines: list[str] = []

    if report.drives:
        lines.append("磁盘容量（本地磁盘）：")
        for drive in report.drives:
            lines.append(
                f"- {drive.label} 总 {format_bytes(drive.total)}，"
                f"已用 {format_bytes(drive.used)}，"
                f"可用 {format_bytes(drive.free)}"
                f"（已用 {_percent(drive.used, drive.total)}%）"
            )
    else:
        lines.append("磁盘容量：没有读取到本地磁盘信息。")

    cleanable = [item for item in report.targets if item.cleanable and item.size > 0]
    needs_confirm = [
        item for item in report.targets if not item.cleanable and item.size > 0
    ]

    if cleanable:
        lines.append("")
        lines.append("可清理的临时/缓存（只读统计，未删除）：")
        for item in sorted(cleanable, key=lambda value: value.size, reverse=True):
            prefix = "≥" if item.truncated else ""
            lines.append(
                f"- {item.label}：{prefix}{format_bytes(item.size)}"
                f"（{item.files} 个文件）"
            )
            display = _display_path(item.path, env)
            if display:
                lines.append(f"  位置：{display}")
            if item.note:
                lines.append(f"  {item.note}")

    clean_keys = [item for item in cleanable if item.key]
    if clean_keys:
        lines.append("")
        lines.append("小兔可代清理（会先弹确认气泡；clean_disk 的 targets 用下列 key）：")
        for item in sorted(clean_keys, key=lambda value: value.size, reverse=True):
            prefix = "≥" if item.truncated else ""
            lines.append(
                f"- {item.key}：{item.label}（{prefix}{format_bytes(item.size)}）"
            )

    if needs_confirm:
        lines.append("")
        lines.append("需要你确认 / 不建议直接删：")
        for item in sorted(needs_confirm, key=lambda value: value.size, reverse=True):
            prefix = "≥" if item.truncated else ""
            lines.append(
                f"- {item.label}：{prefix}{format_bytes(item.size)}"
                f"（{item.files} 个文件）"
            )
            display = _display_path(item.path, env)
            if display:
                lines.append(f"  位置：{display}")
            if item.note:
                lines.append(f"  {item.note}")

    if any(item.truncated for item in report.targets):
        lines.append("")
        lines.append("注：标有“≥”的目录扫描超时/超出预算，实际占用可能更大。")
    lines.append("")
    lines.append("本次只做了读取统计，没有删除任何文件。")
    return "\n".join(lines)
