"""POSIX 白名单目录：用户缓存、临时目录、回收站、下载、浏览器缓存。"""

from __future__ import annotations

import os
from typing import Mapping

from backend.modules.disk.report.models import CleanupTarget
from backend.modules.disk.report.scan import add_dir_target, add_multi_dir_target


def posix_targets(env: Mapping[str, str], deadline: float) -> list[CleanupTarget]:
    home = env.get("HOME") or os.path.expanduser("~")
    cache = env.get("XDG_CACHE_HOME") or os.path.join(home, ".cache")
    targets: list[CleanupTarget] = []
    add_dir_target(
        targets,
        "用户缓存目录",
        cache,
        cleanable=True,
        note="应用缓存；正在使用的文件会被跳过。",
        deadline=deadline,
        key="user_cache",
    )
    add_dir_target(
        targets,
        "系统临时目录",
        "/tmp",
        cleanable=True,
        note="重启后通常会自动清理；正在使用的文件不要删。",
        deadline=deadline,
    )
    add_dir_target(
        targets,
        "回收站",
        os.path.join(home, ".local", "share", "Trash"),
        cleanable=False,
        note="清空回收站才会释放；请用文件管理器清空。",
        deadline=deadline,
        cap_seconds=0.5,
    )
    add_dir_target(
        targets,
        "下载文件夹",
        os.path.join(home, "Downloads"),
        cleanable=False,
        note="个人文件，按需自行整理。",
        deadline=deadline,
        cap_seconds=0.5,
    )
    add_multi_dir_target(
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
