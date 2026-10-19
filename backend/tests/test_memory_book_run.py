"""``prepare_run_program`` 单测（2026-10-19）：run_program 的前置授权解析。

覆盖三种来源：
- 记忆本 program 条目：免确认（kind=program）；
- 用户本轮点名的已安装应用（kind=app，主进程继续匹配 .desktop）；
- 用户本轮给出的临时绝对路径（kind=path，主进程会弹确认）。

安全边界：
- 系统应用名/临时路径必须出现在用户本轮原话里；
- 非 program 条目、失效程序、非可执行文件一律拒绝。
"""

from __future__ import annotations

import os
from pathlib import Path

import pytest

from backend.application.memory_book_service import MemoryBookService
from backend.modules.memory_book import MemoryBookStore
from backend.shared.db import connect_db

_posix_only = pytest.mark.skipif(os.name == "nt", reason="POSIX 执行位语义")


def make_service(tmp_path) -> tuple[MemoryBookStore, MemoryBookService]:
    conn = connect_db(tmp_path / "pet.db")
    store = MemoryBookStore(conn)
    return store, MemoryBookService(store)


def make_executable(tmp_path, name: str = "gedit") -> Path:
    path = tmp_path / name
    path.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
    path.chmod(0o755)
    return path


@_posix_only
def test_memory_book_program_hit_is_trusted(tmp_path) -> None:
    store, service = make_service(tmp_path)
    exe = make_executable(tmp_path)
    store.save(name="编辑器", kind="program", value=str(exe))

    # 记忆本命中即放行（条目本身是用户授权的），不要求本轮点名
    for user_text in ("运行编辑器", "打开它", ""):
        result = service.prepare_run_program({"name": "编辑器"}, user_text)
        assert result["ok"] is True, user_text
        assert result["args"] == {
            "kind": "program",
            "name": "编辑器",
            "path": str(exe),
        }


@_posix_only
def test_installed_app_name_requires_mention(tmp_path) -> None:
    store, service = make_service(tmp_path)
    exe = make_executable(tmp_path)
    store.save(name="编辑器", kind="program", value=str(exe))

    mentioned = service.prepare_run_program({"name": "Firefox"}, "帮我打开 Firefox")
    assert mentioned["ok"] is True
    assert mentioned["args"] == {"kind": "app", "name": "Firefox"}

    # 记忆本没有、用户本轮也没说 → 拒绝（防网页/文件内容诱导）
    denied = service.prepare_run_program({"name": "Firefox"}, "帮我打开浏览器")
    assert denied["ok"] is False
    assert denied["code"] == "name_not_in_message"


@_posix_only
def test_temp_path_requires_mention_and_executable(tmp_path) -> None:
    _store, service = make_service(tmp_path)
    exe = make_executable(tmp_path, "app")

    result = service.prepare_run_program({"path": str(exe)}, f"运行 {exe}")
    assert result["ok"] is True
    assert result["args"] == {"kind": "path", "name": "app", "path": str(exe)}

    denied = service.prepare_run_program({"path": str(exe)}, "运行那个程序")
    assert denied["ok"] is False
    assert denied["code"] == "path_not_in_message"


@_posix_only
def test_tilde_path_counts_as_mentioned(tmp_path, monkeypatch) -> None:
    _store, service = make_service(tmp_path)
    exe = make_executable(tmp_path, "app")
    monkeypatch.setenv("HOME", str(tmp_path))

    result = service.prepare_run_program({"path": "~/app"}, "运行 ~/app")
    assert result["ok"] is True
    assert result["args"]["path"] == str(exe)


@_posix_only
def test_temp_path_rejects_non_program(tmp_path) -> None:
    _store, service = make_service(tmp_path)
    folder = tmp_path / "目录"
    folder.mkdir()

    result = service.prepare_run_program({"path": str(folder)}, f"运行 {folder}")
    assert result["ok"] is False
    assert result["code"] == "bad_program"
    assert "文件夹" in result["message"]


@_posix_only
def test_program_item_must_be_program(tmp_path) -> None:
    store, service = make_service(tmp_path)
    store.save(name="博客", kind="link", value="https://a.com")
    store.save(name="目录", kind="path", value=str(tmp_path))

    for name in ("博客", "目录"):
        result = service.prepare_run_program({"name": name}, f"运行{name}")
        assert result["ok"] is False
        assert result["code"] == "item_not_program"


@_posix_only
def test_missing_or_invalid_program(tmp_path) -> None:
    store, service = make_service(tmp_path)
    exe = make_executable(tmp_path)
    store.save(name="程序", kind="program", value=str(exe))
    exe.unlink()

    missing = service.prepare_run_program({"name": "程序"}, "运行程序")
    assert missing["ok"] is False
    assert missing["code"] == "program_missing"

    assert service.prepare_run_program({}, "运行")["code"] == "run_program_missing"
    both = service.prepare_run_program(
        {"name": "程序", "path": str(tmp_path)}, "运行程序"
    )
    assert both["code"] == "run_program_ambiguous_args"
