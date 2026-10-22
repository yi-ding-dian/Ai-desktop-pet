"""磁盘体检（只读）单测：目录统计、白名单目标、报告渲染与工具接线。"""

from __future__ import annotations

import asyncio
import time
from pathlib import Path

from backend.application.disk_service import DiskService, cleanup_intent
from backend.modules.disk.report import (
    CleanupTarget,
    DiskReport,
    DriveUsage,
    collect_targets,
    directory_size,
    format_bytes,
    render_report,
)
from backend.modules.tools import build_default_registry


def _touch(path: Path, size: int) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"x" * size)


def test_directory_size_counts_nested_files(tmp_path: Path) -> None:
    _touch(tmp_path / "a.txt", 10)
    _touch(tmp_path / "sub" / "b.bin", 32)

    size, files, truncated = directory_size(
        str(tmp_path), deadline=time.monotonic() + 5
    )

    assert size == 42
    assert files == 2
    assert truncated is False


def test_directory_size_name_filter(tmp_path: Path) -> None:
    _touch(tmp_path / "thumbcache_1.db", 7)
    _touch(tmp_path / "iconcache_2.db", 5)
    _touch(tmp_path / "other.bin", 100)

    size, files, _ = directory_size(
        str(tmp_path),
        deadline=time.monotonic() + 5,
        name_filter=lambda name: name.startswith(("thumbcache_", "iconcache_")),
    )

    assert size == 12
    assert files == 2


def test_directory_size_respects_entry_budget(tmp_path: Path) -> None:
    for index in range(5):
        _touch(tmp_path / f"{index}.txt", 1)

    size, files, truncated = directory_size(
        str(tmp_path), deadline=time.monotonic() + 5, max_entries=1
    )

    assert truncated is True
    assert files <= 1
    assert size <= 1


def test_windows_targets_are_whitelisted_and_labelled(tmp_path: Path) -> None:
    local = tmp_path / "Local"
    profile = tmp_path / "User"
    windir = tmp_path / "Windows"
    temp = tmp_path / "Temp"

    _touch(temp / "a.tmp", 10)
    _touch(windir / "Temp" / "b.tmp", 20)
    _touch(windir / "SoftwareDistribution" / "Download" / "c.cab", 30)
    _touch(local / "Google" / "Chrome" / "User Data" / "Default" / "Cache" / "d", 40)
    _touch(local / "Microsoft" / "Windows" / "Explorer" / "thumbcache_1.db", 6)
    _touch(local / "Microsoft" / "Windows" / "Explorer" / "other.bin", 100)
    _touch(profile / "Downloads" / "keep.zip", 50)
    _touch(windir / "WinSxS" / "component.dll", 60)

    targets = collect_targets(
        "win32",
        {
            "LOCALAPPDATA": str(local),
            "USERPROFILE": str(profile),
            "SystemRoot": str(windir),
            "TEMP": str(temp),
            "TMP": str(temp),
            "SystemDrive": "Z:",
        },
        time.monotonic() + 10,
    )
    by_label = {item.label: item for item in targets}

    assert by_label["用户临时文件"].size == 10
    assert by_label["用户临时文件"].cleanable is True
    assert by_label["用户临时文件"].key == "user_temp"
    assert by_label["Windows 更新下载缓存"].size == 30
    assert by_label["Windows 更新下载缓存"].key == ""
    assert by_label["Chrome 缓存"].size == 40
    assert by_label["Chrome 缓存"].key == "chrome_cache"
    assert by_label["缩略图/图标缓存"].size == 6
    assert by_label["缩略图/图标缓存"].key == "thumbnails"
    assert by_label["缩略图/图标缓存"].kind == "files"
    assert by_label["下载文件夹"].size == 50
    assert by_label["下载文件夹"].cleanable is False
    assert by_label["下载文件夹"].key == ""
    assert by_label["WinSxS（组件存储）"].cleanable is False
    assert "DISM" in by_label["WinSxS（组件存储）"].note


def test_render_report_contains_capacity_and_no_deletion(tmp_path: Path) -> None:
    report = DiskReport(
        drives=[DriveUsage(label="C:", total=100, used=75, free=25)],
        targets=[
            CleanupTarget(
                label="用户临时文件",
                path=str(tmp_path / "Temp"),
                size=1024 * 1024,
                files=3,
                cleanable=True,
                note="可以清理",
                key="user_temp",
                paths=(str(tmp_path / "Temp"),),
            ),
            CleanupTarget(
                label="WinSxS（组件存储）",
                path=str(tmp_path / "WinSxS"),
                size=2 * 1024 * 1024,
                files=9,
                cleanable=False,
                note="不要手动删除",
                truncated=True,
            ),
        ],
    )

    text = render_report(report, {"USERPROFILE": str(tmp_path)})

    assert "C:" in text
    assert "1.0 MB" in text
    assert "≥2.0 MB" in text
    assert "不要手动删除" in text
    assert "没有删除任何文件" in text
    assert "user_temp" in text
    assert "小兔可代清理" in text


def test_format_bytes() -> None:
    assert format_bytes(0) == "0 B"
    assert format_bytes(1024) == "1.0 KB"
    assert format_bytes(1024**4) == "1.0 TB"


def test_cleanup_intent() -> None:
    assert cleanup_intent("帮我清理一下 C 盘缓存")
    assert cleanup_intent("把这些清掉吧")
    assert not cleanup_intent("看看 C 盘还有多少空间")
    assert not cleanup_intent("先别清理，我再看看")


def test_prepare_clean_requires_whitelist_key_and_intent() -> None:
    def fake_resolver() -> list[CleanupTarget]:
        return [
            CleanupTarget(
                label="用户临时文件",
                path="/tmp/example",
                size=1024,
                files=2,
                cleanable=True,
                key="user_temp",
                paths=("/tmp/example",),
            )
        ]

    service = DiskService(
        builder=lambda: DiskReport(drives=[], targets=[]),
        clean_resolver=fake_resolver,
    )

    ok = asyncio.run(
        service.prepare_clean({"targets": ["user_temp"]}, "帮我清理一下临时文件")
    )
    assert ok["ok"] is True
    assert ok["args"] == {"targets": ["user_temp"]}

    no_intent = asyncio.run(
        service.prepare_clean({"targets": ["user_temp"]}, "看看 C 盘")
    )
    assert no_intent["code"] == "clean_not_requested"

    unknown = asyncio.run(
        service.prepare_clean({"targets": ["nope"]}, "清理一下")
    )
    assert unknown["code"] == "clean_unknown_target"

    missing = asyncio.run(
        service.prepare_clean({"targets": ["edge_cache"]}, "清理一下")
    )
    assert missing["code"] == "clean_target_missing"


def test_disk_report_tool_registration_and_feedback() -> None:
    class FakeDisk:
        def report_from_tool(self) -> dict[str, object]:
            return {
                "ok": True,
                "code": "disk_reported",
                "message": "看一下",
                "model_content": "磁盘容量：C: 可用 10 GB",
            }

    registry = build_default_registry(disk=FakeDisk())
    spec = registry.get("disk_report")

    assert spec is not None
    assert spec.executor == "backend"
    assert spec.feedback is True
    assert spec.handler is not None

    result = asyncio.run(spec.handler({}))

    assert result["ok"] is True
    assert "磁盘容量" in str(result["model_content"])
