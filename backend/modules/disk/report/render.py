"""把体检结果渲染成给模型看的紧凑文本（不含用户名全路径）。"""

from __future__ import annotations

import os
from typing import Mapping

from backend.modules.disk.report.models import DiskReport, format_bytes


def display_path(path: str, env: Mapping[str, str]) -> str:
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


def percent(used: int, total: int) -> int:
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
                f"（已用 {percent(drive.used, drive.total)}%）"
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
            display = display_path(item.path, env)
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
            display = display_path(item.path, env)
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
