"""可执行程序路径校验（2026-10-19）：记忆本 ``program`` 条目的值。

**只做判定，不执行任何程序。** 真正的启动在 Electron 主进程的 launcher 域
（``frontend/electron/launcher/``），那里还有一套独立校验——后端与主进程各判
一次，模型/渲染进程都无法只靠改一端绕过。

判定原则（与「打开文件」的 ``paths.py`` 不同）：
- 必须是存在、普通的**可执行文件**：POSIX 看任一执行位，Windows 只认 .exe/.com；
- 拒绝 ``.desktop``（那是应用启动器，不是可执行文件本体）；
- 拒绝 ``/proc`` / ``/sys`` / ``/dev`` 下的特殊文件；
- 文件夹、设备、套接字、坏软链接一律拒绝。
"""

from __future__ import annotations

import os
import stat
from pathlib import Path

from backend.modules.memory_book.paths import normalize_path

#: 拒绝的特殊文件系统前缀（Windows 上不存在，自然不参与匹配）
_REJECTED_PREFIXES = ("/proc", "/sys", "/dev")

#: Windows 上允许直接启动的后缀（.bat/.cmd 需要 shell，v1 不支持）
_WINDOWS_EXEC_EXTENSIONS = {".exe", ".com"}


def _expanded_absolute(raw: str) -> str:
    """展开 ``~`` / 环境变量后的绝对路径文本（未要求存在）。"""
    return os.path.expandvars(os.path.expanduser(str(raw or "").strip().strip("\"'")))


def _special_prefix_reason(raw: str) -> str | None:
    """在 realpath 之前拦截特殊文件系统（realpath 可能把它们解析到别处）。"""
    text = _expanded_absolute(raw)
    if not os.path.isabs(text):
        return None
    for prefix in _REJECTED_PREFIXES:
        if text == prefix or text.startswith(prefix + "/"):
            return "不能把系统特殊目录里的文件登记为程序"
    return None


def program_block_reason(raw: str | Path) -> str | None:
    """校验一个值能否作为 ``program`` 条目；能则返回 None，否则返回中文原因。"""
    text = str(raw or "")
    special = _special_prefix_reason(text)
    if special:
        return special
    try:
        path = normalize_path(text)
    except ValueError as exc:
        return str(exc)

    if path.suffix.lower() == ".desktop":
        return "这是应用启动器文件，不是可执行程序；请填写真正的可执行文件路径"

    try:
        info = path.stat()
    except OSError:
        return "程序不存在（或磁盘未连接、没有权限）"
    if stat.S_ISDIR(info.st_mode):
        return "这是文件夹，不是可执行程序"
    if not stat.S_ISREG(info.st_mode):
        return "只支持普通可执行文件"

    if os.name == "nt":
        if path.suffix.lower() not in _WINDOWS_EXEC_EXTENSIONS:
            return "在 Windows 上只支持 .exe / .com 程序"
        return None
    if not info.st_mode & 0o111:
        return "这个文件没有可执行权限（可以用 chmod +x 添加）"
    return None


def normalize_program_path(raw: str | Path) -> Path:
    """校验并返回归一化后的真实路径；不合法抛 ``ValueError``（中文原因）。"""
    reason = program_block_reason(raw)
    if reason:
        raise ValueError(reason)
    return normalize_path(str(raw))


def program_ok(raw: str | Path) -> bool:
    """条目当前是否仍是可执行程序（供列表/快照标注失效）。"""
    return program_block_reason(raw) is None
