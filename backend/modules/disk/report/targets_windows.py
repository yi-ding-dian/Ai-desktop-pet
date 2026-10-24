"""Windows 白名单目录：临时/更新/浏览器缓存、回收站、下载、系统大文件。"""

from __future__ import annotations

import os
import tempfile
from typing import Mapping

from backend.modules.disk.report.models import CleanupTarget
from backend.modules.disk.report.scan import (
    add_dir_target,
    add_file_list_target,
    add_file_target,
    add_multi_dir_target,
    profile_dirs,
)


def windows_message_paths(env: Mapping[str, str]) -> dict[str, str]:
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


def windows_targets(
    env: Mapping[str, str], deadline: float
) -> list[CleanupTarget]:
    paths = windows_message_paths(env)
    local = paths["local"]
    profile = paths["profile"]
    windir = paths["windir"]
    system_drive = paths["system_drive"]
    targets: list[CleanupTarget] = []

    # ---- 可清理：临时文件 / 更新缓存 / 浏览器缓存 ----
    temp_name = os.path.basename(os.path.normpath(paths["temp"])).lower()
    add_dir_target(
        targets,
        "用户临时文件",
        paths["temp"],
        cleanable=True,
        note="正在使用的文件会被跳过；可在系统「存储感知」/磁盘清理里勾选删除。",
        deadline=deadline,
        key="user_temp" if temp_name in ("temp", "tmp") else "",
    )
    add_dir_target(
        targets,
        "系统临时文件",
        os.path.join(windir, "Temp"),
        cleanable=True,
        note="部分文件被系统占用；建议用磁盘清理，不要强行删除。",
        deadline=deadline,
    )
    add_dir_target(
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
    add_file_list_target(
        targets,
        "缩略图/图标缓存",
        thumb_files,
        explorer,
        cleanable=True,
        note="资源管理器会自动重建；只处理 thumbcache/iconcache 文件。",
        key="thumbnails",
    )
    if local:
        chrome = profile_dirs(
            os.path.join(local, "Google", "Chrome", "User Data"),
            ("Cache", "Code Cache", "GPUCache", os.path.join("Service Worker", "CacheStorage")),
        )
        add_multi_dir_target(
            targets,
            "Chrome 缓存",
            chrome,
            cleanable=True,
            note="浏览器缓存；更稳妥的是在 Chrome「清除浏览数据」里清理。",
            deadline=deadline,
            key="chrome_cache",
        )
        edge = profile_dirs(
            os.path.join(local, "Microsoft", "Edge", "User Data"),
            ("Cache", "Code Cache", "GPUCache", os.path.join("Service Worker", "CacheStorage")),
        )
        add_multi_dir_target(
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
        add_multi_dir_target(
            targets,
            "Firefox 缓存",
            firefox,
            cleanable=True,
            note="浏览器缓存；可在 Firefox「清除最近的历史记录」里清理。",
            deadline=deadline,
            key="firefox_cache",
        )

    # ---- 需要用户确认：回收站 / 下载 ----
    add_dir_target(
        targets,
        "回收站",
        os.path.join(system_drive, "$Recycle.Bin"),
        cleanable=False,
        note="清空回收站才会释放；请用桌面回收站或系统「存储感知」。",
        deadline=deadline,
        cap_seconds=0.5,
    )
    add_dir_target(
        targets,
        "下载文件夹",
        os.path.join(profile, "Downloads") if profile else "",
        cleanable=False,
        note="这里是你的个人文件，按需自行整理，小兔不会自动清理。",
        deadline=deadline,
        cap_seconds=0.5,
    )

    # ---- 不要手动删：系统大文件/组件 ----
    add_file_target(
        targets,
        "休眠文件",
        os.path.join(system_drive, "hiberfil.sys"),
        cleanable=False,
        note="不用休眠时可在管理员终端执行 powercfg /h off；不要直接删文件。",
    )
    add_file_target(
        targets,
        "分页文件",
        os.path.join(system_drive, "pagefile.sys"),
        cleanable=False,
        note="系统虚拟内存文件，由 Windows 管理；不要删除。",
    )
    add_dir_target(
        targets,
        "WinSxS（组件存储）",
        os.path.join(windir, "WinSxS"),
        cleanable=False,
        note="严禁手动删除；需要清理请用 DISM /Online /Cleanup-Image /StartComponentCleanup。",
        deadline=deadline,
        cap_seconds=0.8,
    )
    add_dir_target(
        targets,
        "Windows Installer 缓存",
        os.path.join(windir, "Installer"),
        cleanable=False,
        note="卸载/修复程序需要，不要删除。",
        deadline=deadline,
        cap_seconds=0.5,
    )
    add_dir_target(
        targets,
        "旧系统备份 Windows.old",
        os.path.join(system_drive, "Windows.old"),
        cleanable=False,
        note="请用系统「磁盘清理」删除，不要手动删。",
        deadline=deadline,
        cap_seconds=0.5,
    )
    add_dir_target(
        targets,
        "安装包缓存 Package Cache",
        os.path.join(local, "Package Cache") if local else "",
        cleanable=False,
        note="修复/卸载程序可能要用；不建议手动清空。",
        deadline=deadline,
        cap_seconds=0.5,
    )

    return targets
