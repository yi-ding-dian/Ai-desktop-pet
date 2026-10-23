"""Windows 只读系统查询（2026-10-23）：启动项、已安装程序、服务、进程。

边界：
- 只读：不启动/停止服务、不 kill 进程、不写注册表；
- 固定命令：PowerShell/`tasklist` 的脚本与参数都是常量，**不拼接任何用户输入**；
- 进程列表不含命令行，避免把密钥带进模型上下文；
- 非 Windows 平台返回空/降级（服务读取会抛 RuntimeError，由上层提示不支持）。
"""

from __future__ import annotations

import csv
import io
import json
import os
import subprocess
import sys
from typing import Any

#: 单次系统查询最多返回的条数（防止上下文被撑爆）
MAX_STARTUP_ITEMS = 100
MAX_INSTALLED_APPS = 200
MAX_SERVICES = 200
MAX_PROCESSES = 40


def _is_windows() -> bool:
    return sys.platform == "win32"


def _truncate(value: str, limit: int = 300) -> str:
    text = str(value or "").strip()
    return text if len(text) <= limit else text[: limit - 1] + "…"


def _powershell(script: str, timeout: float = 8.0) -> str:
    """执行固定 PowerShell 脚本（常量；不接用户输入），返回 stdout。"""
    if not _is_windows():
        raise RuntimeError("当前系统不支持读取这个信息")
    executable = os.path.join(
        os.environ.get("SystemRoot", r"C:\Windows"),
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
    )
    if not os.path.isfile(executable):
        executable = "powershell.exe"
    creationflags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    try:
        completed = subprocess.run(
            [
                executable,
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                script,
            ],
            shell=False,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout,
            creationflags=creationflags,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise RuntimeError(f"系统查询失败：{exc}") from exc
    if completed.returncode != 0:
        detail = (completed.stderr or "").strip()
        raise RuntimeError(f"系统查询失败：{_truncate(detail, 200) or '未知错误'}")
    return completed.stdout or ""


def _json_rows(raw: str) -> list[dict[str, Any]]:
    text = (raw or "").strip()
    if not text:
        return []
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError as exc:
        raise RuntimeError("系统查询结果解析失败") from exc
    if isinstance(parsed, dict):
        return [parsed]
    if isinstance(parsed, list):
        return [item for item in parsed if isinstance(item, dict)]
    return []


# ---------------------------------------------------------------- 启动项


def _registry_run_items() -> list[dict[str, str]]:
    if not _is_windows():
        return []
    try:
        import winreg
    except ImportError:
        return []

    locations = [
        (winreg.HKEY_CURRENT_USER, r"Software\Microsoft\Windows\CurrentVersion\Run", "HKCU Run", 0),
        (winreg.HKEY_CURRENT_USER, r"Software\Microsoft\Windows\CurrentVersion\RunOnce", "HKCU RunOnce", 0),
        (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\Microsoft\Windows\CurrentVersion\Run", "HKLM Run", 0),
        (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\Microsoft\Windows\CurrentVersion\RunOnce", "HKLM RunOnce", 0),
        (
            winreg.HKEY_LOCAL_MACHINE,
            r"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Run",
            "HKLM Run (32-bit)",
            winreg.KEY_WOW64_32KEY,
        ),
    ]
    items: list[dict[str, str]] = []
    seen: set[tuple[str, str]] = set()
    for root, subkey, source, flags in locations:
        try:
            with winreg.OpenKey(root, subkey, 0, winreg.KEY_READ | flags) as key:
                index = 0
                while True:
                    try:
                        name, value, _ = winreg.EnumValue(key, index)
                    except OSError:
                        break
                    index += 1
                    if not name or not isinstance(value, str):
                        continue
                    key_tuple = (name, value)
                    if key_tuple in seen:
                        continue
                    seen.add(key_tuple)
                    items.append(
                        {
                            "name": _truncate(name, 120),
                            "command": _truncate(value),
                            "source": source,
                        }
                    )
        except OSError:
            continue
    return items


def _startup_folder_items(env: dict[str, str] | None = None) -> list[dict[str, str]]:
    env = env or os.environ
    folders = []
    appdata = env.get("APPDATA")
    programdata = env.get("ProgramData")
    if appdata:
        folders.append(
            (
                os.path.join(
                    appdata,
                    "Microsoft",
                    "Windows",
                    "Start Menu",
                    "Programs",
                    "Startup",
                ),
                "当前用户启动文件夹",
            )
        )
    if programdata:
        folders.append(
            (
                os.path.join(
                    programdata,
                    "Microsoft",
                    "Windows",
                    "Start Menu",
                    "Programs",
                    "Startup",
                ),
                "所有用户启动文件夹",
            )
        )
    items: list[dict[str, str]] = []
    for folder, source in folders:
        try:
            names = sorted(os.listdir(folder))
        except OSError:
            continue
        for name in names:
            if name.lower() == "desktop.ini":
                continue
            items.append(
                {
                    "name": _truncate(name, 120),
                    "command": _truncate(os.path.join(folder, name)),
                    "source": source,
                }
            )
    return items


def startup_items(env: dict[str, str] | None = None) -> list[dict[str, str]]:
    """注册表 Run/RunOnce + 启动文件夹（只读；最多 100 条）。"""
    items = _registry_run_items()
    items.extend(_startup_folder_items(env))
    return items[:MAX_STARTUP_ITEMS]


# ---------------------------------------------------------------- 已安装程序


def installed_apps(limit: int = MAX_INSTALLED_APPS) -> list[dict[str, str]]:
    """读取 Uninstall 注册表项（64/32 位视图），只返回展示信息。"""
    if not _is_windows():
        return []
    try:
        import winreg
    except ImportError:
        return []

    locations = [
        (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall", winreg.KEY_WOW64_64KEY),
        (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall", winreg.KEY_WOW64_32KEY),
        (winreg.HKEY_CURRENT_USER, r"Software\Microsoft\Windows\CurrentVersion\Uninstall", 0),
    ]
    result: list[dict[str, str]] = []
    seen: set[tuple[str, str]] = set()
    for root, subkey, flags in locations:
        try:
            with winreg.OpenKey(root, subkey, 0, winreg.KEY_READ | flags) as key:
                index = 0
                while True:
                    try:
                        child = winreg.EnumKey(key, index)
                    except OSError:
                        break
                    index += 1
                    try:
                        with winreg.OpenKey(key, child) as entry:
                            name = _read_value(entry, "DisplayName")
                            if not name:
                                continue
                            if _read_value(entry, "SystemComponent") == "1":
                                continue
                            version = _read_value(entry, "DisplayVersion")
                            publisher = _read_value(entry, "Publisher")
                            location = _read_value(entry, "InstallLocation")
                    except OSError:
                        continue
                    key_tuple = (name.lower(), version.lower())
                    if key_tuple in seen:
                        continue
                    seen.add(key_tuple)
                    result.append(
                        {
                            "name": _truncate(name, 120),
                            "version": _truncate(version, 60),
                            "publisher": _truncate(publisher, 120),
                            "location": _truncate(location),
                        }
                    )
                    if len(result) >= max(1, limit):
                        return result
        except OSError:
            continue
    return result


def _read_value(key: Any, name: str) -> str:
    try:
        value, _ = winreg_query(key, name)
        if value is None:
            return ""
        if isinstance(value, (list, tuple)):
            return " ".join(str(item) for item in value)
        return str(value)
    except Exception:
        return ""


def winreg_query(key: Any, name: str) -> tuple[Any, int]:
    import winreg

    return winreg.QueryValueEx(key, name)


# ---------------------------------------------------------------- 服务


_SERVICES_SCRIPT = (
    "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; "
    "Get-Service | Sort-Object DisplayName | "
    "Select-Object Name,DisplayName,"
    "@{n='Status';e={$_.Status.ToString()}},"
    "@{n='StartType';e={$_.StartType.ToString()}} | "
    "ConvertTo-Json -Compress"
)


def list_services(limit: int = MAX_SERVICES) -> list[dict[str, str]]:
    """只读查询服务名/显示名/状态/启动类型；不 start/stop。"""
    rows = _json_rows(_powershell(_SERVICES_SCRIPT))
    result: list[dict[str, str]] = []
    for row in rows[: max(1, limit)]:
        name = str(row.get("Name") or "").strip()
        if not name:
            continue
        result.append(
            {
                "name": _truncate(name, 120),
                "display_name": _truncate(str(row.get("DisplayName") or ""), 160),
                "status": _truncate(str(row.get("Status") or ""), 40),
                "start_type": _truncate(str(row.get("StartType") or ""), 40),
            }
        )
    return result


# ---------------------------------------------------------------- 进程


_PROCESS_SCRIPT = (
    "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; "
    "Get-Process | Sort-Object WorkingSet64 -Descending | "
    "Select-Object -First 60 Id,ProcessName,@{n='Memory';e={$_.WorkingSet64}} | "
    "ConvertTo-Json -Compress"
)


def list_processes(limit: int = MAX_PROCESSES) -> list[dict[str, Any]]:
    """只读列出进程（PID/名称/内存）；不含命令行、不 kill。"""
    if not _is_windows():
        rows = _posix_process_rows()
    else:
        try:
            rows = _json_rows(_powershell(_PROCESS_SCRIPT))
        except RuntimeError:
            rows = _tasklist_rows()
    result: list[dict[str, Any]] = []
    for row in rows:
        try:
            pid = int(row.get("Id") or row.get("pid") or 0)
        except (TypeError, ValueError):
            pid = 0
        name = str(row.get("ProcessName") or row.get("name") or "").strip()
        try:
            memory = int(row.get("Memory") or row.get("memory") or 0)
        except (TypeError, ValueError):
            memory = 0
        if not name and pid <= 0:
            continue
        result.append({"pid": pid, "name": _truncate(name, 120), "memory": memory})
        if len(result) >= max(1, limit):
            break
    return result


def _tasklist_rows() -> list[dict[str, Any]]:
    """PowerShell 不可用时的进程回退：tasklist CSV（固定参数）。"""
    if not _is_windows():
        return []
    creationflags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    try:
        completed = subprocess.run(
            ["tasklist", "/FO", "CSV", "/NH"],
            shell=False,
            capture_output=True,
            text=True,
            encoding="mbcs",
            errors="replace",
            timeout=8,
            creationflags=creationflags,
        )
    except (OSError, subprocess.TimeoutExpired):
        return []
    if completed.returncode != 0:
        return []
    rows: list[dict[str, Any]] = []
    reader = csv.reader(io.StringIO(completed.stdout or ""))
    for columns in reader:
        if len(columns) < 2:
            continue
        name = columns[0].strip()
        try:
            pid = int(columns[1].strip())
        except ValueError:
            continue
        memory = 0
        if len(columns) >= 5:
            digits = "".join(ch for ch in columns[-1] if ch.isdigit())
            if digits:
                memory = int(digits) * 1024
        rows.append({"name": name, "pid": pid, "memory": memory})
    rows.sort(key=lambda item: int(item.get("memory") or 0), reverse=True)
    return rows


def _posix_process_rows() -> list[dict[str, Any]]:
    """Linux/macOS 的进程列表：只读 /proc，名称 + RSS；不含命令行。"""
    rows: list[dict[str, Any]] = []
    try:
        page_size = int(os.sysconf("SC_PAGE_SIZE"))
    except (ValueError, OSError, AttributeError):
        page_size = 4096
    try:
        pids = [name for name in os.listdir("/proc") if name.isdigit()]
    except OSError:
        return rows
    for pid_text in pids:
        try:
            with open(f"/proc/{pid_text}/stat", "r", encoding="utf-8", errors="replace") as handle:
                raw = handle.read()
        except OSError:
            continue
        closing = raw.rfind(")")
        opening = raw.find("(")
        if opening < 0 or closing <= opening:
            continue
        name = raw[opening + 1 : closing]
        fields = raw[closing + 2 :].split()
        if len(fields) < 22:
            continue
        try:
            rss = int(fields[21]) * page_size
        except ValueError:
            rss = 0
        rows.append({"pid": int(pid_text), "name": name, "memory": max(0, rss)})
    rows.sort(key=lambda item: int(item.get("memory") or 0), reverse=True)
    return rows
