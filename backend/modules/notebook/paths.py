"""记忆本路径安全（2026-10-18）：本机路径的归一化与"是否允许删除"判定。

**本文件只做判定，不删除任何东西。** 真正的删除在 Electron 主进程里经
``shell.trashItem`` 执行（移入系统回收站），并且那里还有一道独立校验
（``frontend/electron/system/path-safety.ts``）——后端与主进程各拦一次，
模型/渲染进程都无法绕过。

判定原则：
- 只接受绝对路径；``~`` / ``%VAR%`` / ``$VAR`` 先展开；
- 软链接先 ``realpath`` 解析，按真实目标判定；
- 盘符/文件系统根、用户主目录、系统目录、应用安装/数据目录一律拒绝；
- 删除一个**祖先目录**（例如 ``C:\\``、``/home``）同样拒绝——
  它会把受保护目录一起带走。
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

from backend.shared.paths import get_data_dir


def normalize_path(raw: str) -> Path:
    """把用户/模型给的路径归一化为绝对真实路径（不要求存在）。

    抛 ``ValueError``：空、非绝对路径、路径过长。
    """
    text = str(raw or "").strip().strip("\"'")
    if not text:
        raise ValueError("路径不能为空")
    expanded = os.path.expandvars(os.path.expanduser(text))
    if not os.path.isabs(expanded):
        raise ValueError("请提供绝对路径（例如 D:\\项目 或 /home/me/项目）")
    try:
        # realpath 解析软链接；abspath 清掉 .. / .；不要求目标存在
        resolved = os.path.realpath(os.path.abspath(expanded))
    except OSError as exc:
        raise ValueError(f"路径无法解析：{exc}") from exc
    if len(resolved) > 1000:
        raise ValueError("路径太长了")
    return Path(resolved)


def normalize_existing_path(raw: str) -> tuple[Path, bool]:
    """归一化并校验路径当前存在；返回 ``(真实路径, 是否文件夹)``。

    只接受普通文件或文件夹（设备、套接字、坏软链接一律拒绝）。
    """
    path = normalize_path(raw)
    try:
        exists = path.exists()
    except OSError as exc:
        raise ValueError(f"路径无法访问：{exc}") from exc
    if not exists:
        raise ValueError("路径不存在（或磁盘未连接、没有权限）")
    if path.is_dir():
        return path, True
    if path.is_file():
        return path, False
    raise ValueError("只支持普通文件或文件夹")


def _add(entries: list[tuple[Path, str, bool]], raw: str | None, reason: str, *, descendants: bool) -> None:
    """登记一个受保护目录（忽略空值/不存在的项；重复项无害）。"""
    if not raw:
        return
    try:
        path = Path(os.path.realpath(os.path.abspath(os.path.expandvars(os.path.expanduser(raw)))))
    except OSError:
        return
    if path not in {entry[0] for entry in entries}:
        entries.append((path, reason, descendants))


def _protected_entries() -> list[tuple[Path, str, bool]]:
    """受保护目录清单：``(路径, 拒绝原因, 是否连子路径一起保护)``。

    清单同时包含 Windows 与 POSIX 的典型系统目录——在对应平台上不存在的项
    自然不参与匹配，不需要按平台分支（平台差异不落到业务判定里）。
    """
    entries: list[tuple[Path, str, bool]] = []

    # 文件系统根 / 盘符根（由目标路径与当前环境推导，跨平台）
    for anchor in {Path.cwd().anchor, Path.home().anchor}:
        if anchor:
            _add(entries, anchor, "这是磁盘/文件系统根目录", descendants=False)

    # 用户主目录：只保护主目录本身与其父目录（例如 C:\Users、/home），
    # 允许删除主目录里的具体文件/文件夹（用户的真实使用场景）。
    home = Path.home()
    _add(entries, str(home), "这是用户主目录", descendants=False)
    _add(entries, str(home.parent), "这是用户主目录的上级目录", descendants=False)

    # Windows 系统目录（环境变量缺失时自然跳过）
    _add(entries, os.environ.get("SystemRoot") or os.environ.get("windir"), "这是 Windows 系统目录", descendants=True)
    _add(entries, os.environ.get("ProgramFiles"), "这是程序安装目录", descendants=True)
    _add(entries, os.environ.get("ProgramFiles(x86)"), "这是程序安装目录", descendants=True)
    _add(entries, os.environ.get("ProgramData"), "这是系统数据目录", descendants=True)

    # POSIX 系统目录
    for raw in ("/bin", "/sbin", "/usr", "/etc", "/var", "/boot", "/dev", "/proc", "/sys", "/lib", "/lib64"):
        _add(entries, raw, "这是系统目录", descendants=True)

    # 应用自身：数据目录（数据库/配置）与后端可执行文件目录——删了会把宠物弄坏
    _add(entries, str(get_data_dir()), "这是小兔的数据目录", descendants=True)
    _add(entries, str(Path(sys.executable).resolve().parent), "这是小兔的程序目录", descendants=True)
    # 当前工作目录：只保护它本身（及其祖先），不保护里面的普通文件——
    # 开发者可能让宠物删除项目里的旧目录。
    _add(entries, str(Path.cwd()), "这是当前工作目录", descendants=False)

    return entries


def protected_reason(path: Path) -> str | None:
    """目标路径是否受保护；受保护返回中文原因，否则 None。

    - 路径等于受保护目录 → 拒绝；
    - 受保护目录是路径的**祖先**（删路径会带走受保护目录）→ 拒绝；
    - 受保护目录标记了 ``descendants`` 且路径位于其内部 → 拒绝。
    """
    try:
        target = Path(os.path.realpath(os.path.abspath(str(path))))
    except OSError:
        return "路径无法解析"
    for protected, reason, descendants in _protected_entries():
        if target == protected:
            return reason
        try:
            if protected.is_relative_to(target):
                return f"删除它会连同受保护的「{protected}」一起删掉"
            if descendants and target.is_relative_to(protected):
                return reason
        except (OSError, ValueError):
            continue
    return None


def deletable_block_reason(path: Path) -> str | None:
    """删除前校验：必须存在且不在保护范围；返回拒绝原因或 None。"""
    try:
        if not path.exists():
            return "路径不存在（或磁盘未连接、没有权限）"
    except OSError as exc:
        return f"路径无法访问：{exc}"
    if not (path.is_file() or path.is_dir()):
        return "只支持普通文件或文件夹"
    return protected_reason(path)
