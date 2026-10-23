"""只读目录扫描（2026-10-23）：一级目录占用、最大文件。

**只统计名字/大小，不读文件正文。** 所有入口都带时间与条目上限；不跟随符号
链接/junction，避免环和越界。
"""

from __future__ import annotations

import heapq
import os
import time
from dataclasses import dataclass

#: 单次扫描最多访问的目录项
MAX_ENTRIES = 200_000
#: 单次扫描默认时间预算（秒）
DEFAULT_BUDGET_SECONDS = 3.0


@dataclass(frozen=True)
class DirUsage:
    name: str
    path: str
    size: int
    files: int
    is_dir: bool
    truncated: bool = False


@dataclass(frozen=True)
class FileUsage:
    path: str
    size: int


def resolve_directory(raw: object) -> str:
    """校验并返回真实绝对目录；失败抛 ValueError（中文原因可展示）。"""
    text = str(raw or "").strip().strip("\"'")
    if not text:
        raise ValueError("路径不能为空")
    if "\0" in text or "\n" in text or "\r" in text:
        raise ValueError("路径里有非法字符")
    expanded = os.path.expandvars(os.path.expanduser(text))
    if not os.path.isabs(expanded):
        raise ValueError("请使用绝对路径")
    # UNC/网络路径可能长时间无响应：V1 只读巡检不碰
    if expanded.startswith("\\\\") or expanded.startswith("//"):
        raise ValueError("暂不支持网络路径（UNC）")
    try:
        resolved = os.path.realpath(expanded)
    except OSError as exc:
        raise ValueError(f"路径不可用：{exc}") from exc
    if not os.path.isdir(resolved):
        raise ValueError("这个路径不是文件夹，或者现在不可用")
    return resolved


def _is_link(entry: os.DirEntry[str]) -> bool:
    try:
        if entry.is_symlink():
            return True
        is_junction = getattr(entry, "is_junction", None)
        return bool(is_junction is not None and is_junction())
    except OSError:
        return False


def tree_size(
    root: str,
    *,
    deadline: float,
    max_entries: int = MAX_ENTRIES,
) -> tuple[int, int, bool]:
    """统计目录树占用；返回 ``(bytes, files, truncated)``。"""
    total = 0
    files = 0
    entries = 0
    truncated = False
    stack = [root]

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
                if _is_link(entry):
                    continue
                try:
                    if entry.is_dir(follow_symlinks=False):
                        stack.append(entry.path)
                    elif entry.is_file(follow_symlinks=False):
                        total += entry.stat(follow_symlinks=False).st_size
                        files += 1
                except OSError:
                    continue
        if truncated:
            break

    return total, files, truncated


def top_level_usage(
    root: str,
    *,
    limit: int = 10,
    budget_seconds: float = DEFAULT_BUDGET_SECONDS,
) -> tuple[list[DirUsage], bool]:
    """统计 ``root`` 下一级目录/文件的占用，按大小降序返回前 ``limit`` 项。"""
    directory = resolve_directory(root)
    budget = max(0.5, budget_seconds)
    deadline = time.monotonic() + budget
    result: list[DirUsage] = []
    truncated_any = False

    try:
        with os.scandir(directory) as iterator:
            # 先取名字再分配时间：否则前面的巨型目录会吃光预算，
            # 后面的 Windows/Users 之类根本不出现在结果里。
            entries = list(iterator)
    except OSError as exc:
        raise ValueError(f"读取目录失败：{exc}") from exc

    # 给每个子项一个可用的时间片；总预算仍由 deadline 兜底。
    # 不按 1/n 均分，否则 Windows/Users 这类大目录只能扫到几百 MB。
    per_child = min(1.0, max(0.3, 2.0 * budget / max(1, len(entries))))
    for entry in entries:
        if time.monotonic() >= deadline:
            truncated_any = True
            break
        if _is_link(entry):
            continue
        try:
            if entry.is_dir(follow_symlinks=False):
                size, files, cut = tree_size(
                    entry.path,
                    deadline=min(deadline, time.monotonic() + per_child),
                )
                result.append(
                    DirUsage(
                        name=entry.name,
                        path=entry.path,
                        size=size,
                        files=files,
                        is_dir=True,
                        truncated=cut,
                    )
                )
            elif entry.is_file(follow_symlinks=False):
                size = entry.stat(follow_symlinks=False).st_size
                result.append(
                    DirUsage(
                        name=entry.name,
                        path=entry.path,
                        size=size,
                        files=1,
                        is_dir=False,
                    )
                )
        except OSError:
            continue

    result.sort(key=lambda item: item.size, reverse=True)
    return result[: max(1, limit)], truncated_any or any(
        item.truncated for item in result
    )


def largest_files(
    root: str,
    *,
    limit: int = 20,
    budget_seconds: float = DEFAULT_BUDGET_SECONDS,
) -> tuple[list[FileUsage], bool]:
    """扫描目录树，返回最大的 ``limit`` 个文件（只取 size/path）。"""
    directory = resolve_directory(root)
    deadline = time.monotonic() + max(0.5, budget_seconds)
    wanted = max(1, limit)
    heap: list[tuple[int, str]] = []
    entries_seen = 0
    truncated = False
    stack = [directory]

    while stack:
        if time.monotonic() >= deadline or entries_seen >= MAX_ENTRIES:
            truncated = True
            break
        current = stack.pop()
        try:
            iterator = os.scandir(current)
        except OSError:
            continue
        with iterator:
            for entry in iterator:
                entries_seen += 1
                if time.monotonic() >= deadline or entries_seen >= MAX_ENTRIES:
                    truncated = True
                    break
                if _is_link(entry):
                    continue
                try:
                    if entry.is_dir(follow_symlinks=False):
                        stack.append(entry.path)
                    elif entry.is_file(follow_symlinks=False):
                        size = entry.stat(follow_symlinks=False).st_size
                        if len(heap) < wanted:
                            heapq.heappush(heap, (size, entry.path))
                        elif size > heap[0][0]:
                            heapq.heapreplace(heap, (size, entry.path))
                except OSError:
                    continue
        if truncated:
            break

    files = [FileUsage(path=item[1], size=item[0]) for item in heap]
    files.sort(key=lambda item: item.size, reverse=True)
    return files, truncated
