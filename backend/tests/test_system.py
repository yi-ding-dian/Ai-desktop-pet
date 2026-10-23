"""只读系统巡检单测：目录扫描、路径校验、op 分派、工具注册。"""

from __future__ import annotations

import asyncio
from pathlib import Path

import pytest

from backend.application.system_service import (
    SystemService,
    format_bytes,
    format_duration,
)
from backend.modules.system import scan
from backend.modules.system.info import DriveInfo, SystemInfo
from backend.modules.tools import build_default_registry


def _write(path: Path, size: int) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"x" * size)


def test_resolve_directory_rejects_relative_and_unc() -> None:
    with pytest.raises(ValueError):
        scan.resolve_directory("relative/path")
    with pytest.raises(ValueError):
        scan.resolve_directory("//server/share")
    with pytest.raises(ValueError):
        scan.resolve_directory("")


def test_top_level_usage_orders_by_size(tmp_path: Path) -> None:
    _write(tmp_path / "big" / "a.bin", 100)
    _write(tmp_path / "small" / "b.bin", 10)
    _write(tmp_path / "root.bin", 50)

    items, truncated = scan.top_level_usage(
        str(tmp_path), limit=10, budget_seconds=5
    )

    assert truncated is False
    assert [item.name for item in items] == ["big", "root.bin", "small"]
    assert items[0].size == 100
    assert items[0].files == 1
    assert items[1].size == 50
    assert items[1].is_dir is False


def test_largest_files_returns_top_n(tmp_path: Path) -> None:
    _write(tmp_path / "a" / "small.bin", 10)
    _write(tmp_path / "a" / "large.bin", 200)
    _write(tmp_path / "b" / "medium.bin", 100)

    files, truncated = scan.largest_files(
        str(tmp_path), limit=2, budget_seconds=5
    )

    assert truncated is False
    assert [item.size for item in files] == [200, 100]
    assert files[0].path.endswith("large.bin")


def test_system_service_top_dirs_and_largest(tmp_path: Path) -> None:
    _write(tmp_path / "big" / "a.bin", 100)
    _write(tmp_path / "small" / "b.bin", 10)
    service = SystemService()

    top = service.inspect_from_tool(
        {"op": "top_dirs", "path": str(tmp_path), "limit": 5}
    )
    assert top["ok"] is True
    assert "big" in top["model_content"]

    largest = service.inspect_from_tool(
        {"op": "largest_files", "path": str(tmp_path), "limit": 1}
    )
    assert largest["ok"] is True
    assert "a.bin" in largest["model_content"]


def test_system_service_formats_injected_info() -> None:
    info = SystemInfo(
        os_name="TestOS 1.0",
        os_release="1.0",
        os_version="build 1",
        machine="x86_64",
        processor="Test CPU",
        cpu_count=8,
        memory_total=16 * 1024**3,
        memory_available=8 * 1024**3,
        uptime_seconds=3661,
    )
    service = SystemService(info_provider=lambda: info)

    result = service.inspect_from_tool({"op": "system_info"})

    assert result["ok"] is True
    text = result["model_content"]
    assert "TestOS 1.0" in text
    assert "8 核" in text
    assert "16.0 GB" in text
    assert "1 小时" in text


def test_system_service_drives_and_bad_requests() -> None:
    service = SystemService(
        drive_provider=lambda: [
            DriveInfo(label="C:", total=100, used=75, free=25)
        ]
    )
    drives = service.inspect_from_tool({"op": "drives"})
    assert drives["ok"] is True
    assert "C:" in drives["model_content"]
    assert "75%" in drives["model_content"]

    bad_op = service.inspect_from_tool({"op": "format_disk"})
    assert bad_op["ok"] is False
    assert bad_op["code"] == "system_bad_op"

    bad_path = service.inspect_from_tool({"op": "top_dirs", "path": "relative"})
    assert bad_path["ok"] is False
    assert bad_path["code"] == "system_bad_path"


def test_system_format_helpers() -> None:
    assert format_bytes(1024) == "1.0 KB"
    assert format_duration(3661) == "1 小时 1 分钟"
    assert format_duration(59) == "0 分钟"


def test_inspect_system_tool_registration() -> None:
    class FakeSystem:
        def inspect_from_tool(self, args: dict[str, object]) -> dict[str, object]:
            return {
                "ok": True,
                "code": "system_inspected",
                "message": "看好了",
                "model_content": f"op={args.get('op')}",
            }

    registry = build_default_registry(system=FakeSystem())
    spec = registry.get("inspect_system")

    assert spec is not None
    assert spec.executor == "backend"
    assert spec.feedback is True
    assert spec.handler is not None

    result = asyncio.run(spec.handler({"op": "processes"}))
    assert result["model_content"] == "op=processes"
