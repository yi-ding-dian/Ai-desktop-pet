"""编码代理工具单测（2026-10-23）：注册、参数校验、工作区确认。

真正的执行在 Electron 主进程拉起的 dsh 子进程里，这里只测后端派发前的校验。
"""

from __future__ import annotations

import asyncio

from backend.modules.tools import build_default_registry


def _prepare(args: dict, user_text: str) -> dict:
    registry = build_default_registry()
    spec = registry.get("delegate_coding")
    assert spec is not None
    assert spec.prepare is not None
    return asyncio.run(spec.prepare(args, user_text))


def test_delegate_coding_registered_as_frontend_tool() -> None:
    registry = build_default_registry()
    spec = registry.get("delegate_coding")
    assert spec is not None
    assert spec.executor == "frontend"
    assert spec.prepare is not None
    assert "task" in spec.parameters["properties"]
    assert spec.parameters["required"] == ["task"]


def test_prepare_accepts_task_without_workspace() -> None:
    result = _prepare({"task": "帮我修一下登录 bug"}, "帮我修一下登录 bug")
    assert result["ok"] is True
    assert result["args"]["task"] == "帮我修一下登录 bug"
    assert result["args"]["workspace"] == ""


def test_prepare_accepts_workspace_named_by_user() -> None:
    result = _prepare(
        {"task": "加一个设置项", "workspace": "D:\\myProject\\demo"},
        "帮我在 D:/myProject/demo 里加一个设置项",
    )
    assert result["ok"] is True
    assert result["args"]["workspace"].replace("\\", "/").lower().endswith("myproject/demo")


def test_prepare_rejects_workspace_not_in_user_text() -> None:
    result = _prepare(
        {"task": "改代码", "workspace": "D:\\secret\\project"},
        "帮我改一下代码",
    )
    assert result["ok"] is False
    assert result["code"] == "coding_workspace_unconfirmed"


def test_prepare_rejects_relative_workspace() -> None:
    result = _prepare({"task": "改代码", "workspace": "demo"}, "在 demo 里改代码")
    assert result["ok"] is False
    assert result["code"] == "coding_workspace_relative"


def test_prepare_rejects_empty_task() -> None:
    result = _prepare({"task": "   "}, "帮我干活")
    assert result["ok"] is False
    assert result["code"] == "coding_task_missing"


def test_prepare_rejects_overlong_task() -> None:
    result = _prepare({"task": "x" * 2001}, "跑一下")
    assert result["ok"] is False
    assert result["code"] == "coding_task_too_long"
