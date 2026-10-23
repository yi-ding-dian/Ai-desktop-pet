"""只读系统巡检用例（2026-10-23）。

工具层 ``inspect_system`` 的 op 分派、参数校验与文本格式化。**只读**：
不执行任意命令、不读写文件正文、不 kill 进程、不启停服务、不写注册表。

输出统一压成 ``model_content``（给模型阅读），并限制总长度；错误返回
``{ok: false, code, message}``，由工具层转成通知。
"""

from __future__ import annotations

import os
import sys
from typing import Any, Callable

from loguru import logger

from backend.modules.system import scan, windows
from backend.modules.system.info import (
    DriveInfo,
    SystemInfo,
    collect_system_info,
    list_drives,
)

#: model_content 字符上限（防止把上下文撑爆）
MAX_OUTPUT_CHARS = 8000

OPS = (
    "system_info",
    "drives",
    "top_dirs",
    "largest_files",
    "startup_items",
    "installed_apps",
    "services",
    "processes",
)


def _text(args: dict[str, Any], key: str) -> str:
    value = args.get(key)
    return value.strip() if isinstance(value, str) else ""


def _limit(args: dict[str, Any], default: int, maximum: int) -> int:
    raw = args.get("limit")
    try:
        value = int(raw) if raw is not None else default
    except (TypeError, ValueError):
        value = default
    return max(1, min(maximum, value))


def format_bytes(size: int) -> str:
    value = float(max(0, int(size)))
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if value < 1024 or unit == "TB":
            return f"{int(value)} B" if unit == "B" else f"{value:.1f} {unit}"
        value /= 1024
    return f"{value:.1f} TB"


def format_duration(seconds: float) -> str:
    total = max(0, int(seconds))
    days, remainder = divmod(total, 86400)
    hours, remainder = divmod(remainder, 3600)
    minutes = remainder // 60
    parts: list[str] = []
    if days:
        parts.append(f"{days} 天")
    if hours:
        parts.append(f"{hours} 小时")
    if minutes or not parts:
        parts.append(f"{minutes} 分钟")
    return " ".join(parts)


def _display_path(raw: str, env: dict[str, str] | None = None) -> str:
    """把用户目录/系统目录替换成环境变量形式，避免用户名进入模型上下文。"""
    env = env or os.environ
    text = str(raw or "")
    for key in ("USERPROFILE", "LOCALAPPDATA", "APPDATA", "SystemRoot", "WINDIR", "HOME"):
        value = env.get(key)
        if value and text.lower().startswith(value.lower()):
            return f"%{key}%" + text[len(value) :]
    return text


def _truncate(text: str, limit: int = MAX_OUTPUT_CHARS) -> str:
    if len(text) <= limit:
        return text
    return text[: limit - 20] + "\n…（输出已截断）"


class SystemService:
    """只读系统巡检；provider 可注入（测试/未来替换平台实现）。"""

    def __init__(
        self,
        info_provider: Callable[[], SystemInfo] = collect_system_info,
        drive_provider: Callable[[], list[DriveInfo]] = list_drives,
        top_provider: Callable[..., tuple[list[scan.DirUsage], bool]] = scan.top_level_usage,
        largest_provider: Callable[..., tuple[list[scan.FileUsage], bool]] = scan.largest_files,
        startup_provider: Callable[[], list[dict[str, str]]] = windows.startup_items,
        apps_provider: Callable[..., list[dict[str, str]]] = windows.installed_apps,
        services_provider: Callable[..., list[dict[str, str]]] = windows.list_services,
        processes_provider: Callable[..., list[dict[str, Any]]] = windows.list_processes,
    ) -> None:
        self._info = info_provider
        self._drives = drive_provider
        self._top = top_provider
        self._largest = largest_provider
        self._startup = startup_provider
        self._apps = apps_provider
        self._services = services_provider
        self._processes = processes_provider

    def inspect_from_tool(self, args: dict[str, Any]) -> dict[str, Any]:
        op = _text(args, "op").lower()
        if op not in OPS:
            return {
                "ok": False,
                "code": "system_bad_op",
                "message": "要看什么系统信息？可用：" + "、".join(OPS),
            }
        try:
            text = self._dispatch(op, args)
        except ValueError as exc:
            return {"ok": False, "code": "system_bad_path", "message": str(exc)}
        except RuntimeError as exc:
            return {"ok": False, "code": "system_query_failed", "message": str(exc)}
        except Exception:
            logger.exception("系统巡检失败：op={}", op)
            return {
                "ok": False,
                "code": "system_query_failed",
                "message": "系统信息暂时读不到，等会儿再试好吗？",
            }
        if not text.strip():
            return {
                "ok": False,
                "code": "system_empty",
                "message": "没有读取到信息（可能没有权限，或当前系统不支持）。",
            }
        return {
            "ok": True,
            "code": "system_inspected",
            "message": "看好了～",
            "model_content": _truncate(text),
        }

    # ---------------------------------------------------------------- 分派

    def _dispatch(self, op: str, args: dict[str, Any]) -> str:
        if op == "system_info":
            return self._format_info(self._info())
        if op == "drives":
            return self._format_drives(self._drives())
        if op == "top_dirs":
            root = _text(args, "path") or self._default_top_root()
            items, truncated = self._top(
                root, limit=_limit(args, 10, 30), budget_seconds=3.0
            )
            return self._format_top(root, items, truncated)
        if op == "largest_files":
            root = _text(args, "path") or os.path.expanduser("~")
            items, truncated = self._largest(
                root, limit=_limit(args, 20, 50), budget_seconds=3.0
            )
            return self._format_largest(root, items, truncated)
        if op == "startup_items":
            return self._format_startup(self._startup())
        if op == "installed_apps":
            return self._format_apps(self._apps(limit=_limit(args, 100, 200)))
        if op == "services":
            return self._format_services(self._services(limit=_limit(args, 100, 200)))
        if op == "processes":
            return self._format_processes(self._processes(limit=_limit(args, 30, 40)))
        raise ValueError("不支持的系统查询")

    @staticmethod
    def _default_top_root() -> str:
        if sys.platform == "win32":
            return os.environ.get("SystemDrive", "C:") + "\\"
        return os.path.expanduser("~")

    # ---------------------------------------------------------------- 格式化

    @staticmethod
    def _format_info(info: SystemInfo) -> str:
        version = info.os_name
        if info.os_version:
            version = f"{version}（{info.os_version}）"
        processor = f"（{info.processor}）" if info.processor else ""
        memory = (
            f"总 {format_bytes(info.memory_total)}，"
            f"可用 {format_bytes(info.memory_available)}"
            if info.memory_total
            else "未读取到"
        )
        return "\n".join(
            [
                f"系统：{version}",
                f"CPU：{info.cpu_count} 核{processor}" if info.cpu_count else "CPU：未读取到",
                f"内存：{memory}",
                f"已开机：{format_duration(info.uptime_seconds)}",
            ]
        )

    @staticmethod
    def _format_drives(drives: list[DriveInfo]) -> str:
        if not drives:
            return "没有读取到本地磁盘信息。"
        lines = ["磁盘容量（本地磁盘）："]
        for drive in drives:
            percent = round(drive.used * 100 / drive.total) if drive.total else 0
            lines.append(
                f"- {drive.label} 总 {format_bytes(drive.total)}，"
                f"可用 {format_bytes(drive.free)}（已用 {percent}%）"
            )
        return "\n".join(lines)

    @staticmethod
    def _format_top(root: str, items: list[scan.DirUsage], truncated: bool) -> str:
        if not items:
            return "没有读取到目录内容（可能没有权限）。"
        lines = [
            f"{_display_path(root)} 下一级占用（按大小排序，最多 {len(items)} 项）："
        ]
        for item in items:
            prefix = "≥" if item.truncated else ""
            suffix = f"（{item.files} 个文件）" if item.is_dir else ""
            name = item.name + ("/" if item.is_dir else "")
            lines.append(f"- {name}：{prefix}{format_bytes(item.size)}{suffix}")
        if truncated:
            lines.append("")
            lines.append("注：扫描达到时间/条目上限，数值可能不完整。")
        return "\n".join(lines)

    @staticmethod
    def _format_largest(
        root: str, items: list[scan.FileUsage], truncated: bool
    ) -> str:
        if not items:
            return "没有读取到文件（可能没有权限）。"
        lines = [f"{_display_path(root)} 下最大的 {len(items)} 个文件："]
        for item in items:
            lines.append(f"- {format_bytes(item.size)}  {_display_path(item.path)}")
        if truncated:
            lines.append("")
            lines.append("注：扫描达到时间/条目上限，可能还有更大的文件未列出。")
        return "\n".join(lines)

    @staticmethod
    def _format_startup(items: list[dict[str, str]]) -> str:
        if not items:
            return "没有读取到启动项（仅支持 Windows，或没有权限）。"
        lines = ["启动项（只读）："]
        for item in items:
            source = item.get("source", "")
            command = item.get("command", "")
            lines.append(f"- {item.get('name', '')}：{command}（{source}）")
        return "\n".join(lines)

    @staticmethod
    def _format_apps(items: list[dict[str, str]]) -> str:
        if not items:
            return "没有读取到已安装程序（仅支持 Windows，或没有权限）。"
        lines = [f"已安装程序（{len(items)} 项，只读）："]
        for item in items:
            version = f" {item['version']}" if item.get("version") else ""
            publisher = f"（{item['publisher']}）" if item.get("publisher") else ""
            lines.append(f"- {item.get('name', '')}{version}{publisher}")
        return "\n".join(lines)

    @staticmethod
    def _format_services(items: list[dict[str, str]]) -> str:
        if not items:
            return "没有读取到服务（仅支持 Windows，或没有权限）。"
        lines = [f"服务（{len(items)} 项，只读）："]
        for item in items:
            name = item.get("name", "")
            display = item.get("display_name", "")
            label = f"{display}（{name}）" if display else name
            lines.append(
                f"- {label}：{item.get('status', '')} / {item.get('start_type', '')}"
            )
        return "\n".join(lines)

    @staticmethod
    def _format_processes(items: list[dict[str, Any]]) -> str:
        if not items:
            return "没有读取到进程（可能没有权限）。"
        lines = [f"进程（按内存排序，共 {len(items)} 项；只读，不含命令行）："]
        for item in items:
            lines.append(
                f"- {item.get('name', '')}（PID {item.get('pid', 0)}）："
                f"{format_bytes(int(item.get('memory') or 0))}"
            )
        return "\n".join(lines)
