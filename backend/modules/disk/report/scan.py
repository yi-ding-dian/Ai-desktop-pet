"""目录占用统计与候选目标累加（不跟随符号链接，带时间/条目预算）。"""

from __future__ import annotations

import os
import stat
import time
from typing import Callable, Iterable, Sequence

from backend.modules.disk.report.models import CleanupTarget

#: 单个目录最多遍历的条目数（防止用户目录里有几十万文件）
MAX_ENTRIES_PER_DIR = 200_000

#: 单个目录的默认扫描上限（秒）
DEFAULT_DIR_CAP_SECONDS = 1.0


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


def existing_dir(path: str | None) -> str:
    if not path:
        return ""
    try:
        return path if os.path.isdir(path) else ""
    except OSError:
        return ""


def add_dir_target(
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
    directory = existing_dir(path)
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


def add_multi_dir_target(
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
    directories = [item for item in (existing_dir(path) for path in paths) if item]
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


def add_file_target(
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


def add_file_list_target(
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


def profile_dirs(root: str, suffixes: Sequence[str]) -> list[str]:
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
