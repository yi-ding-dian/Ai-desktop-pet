"""内部任务配置端点单测（默认工作区读取与「设为默认」写回，2026-10-25）。"""

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

import backend.shared.config as config_module
from backend.interfaces.ws.server import create_app
from backend.shared.config import AppConfig

_INTERNAL = "internal-token-for-test"
_HEADER = {"X-Pet-Internal-Token": _INTERNAL}


def _client(token: str | None = _INTERNAL) -> TestClient:
    app = create_app(dispatcher=object(), app_version="test", internal_token=token)  # type: ignore[arg-type]
    return TestClient(app)


def test_rejects_missing_token() -> None:
    assert _client(token=None).get("/internal/agent-config").status_code == 403


def test_get_returns_configured_workspace(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        config_module,
        "load_config",
        lambda: SimpleNamespace(agent=SimpleNamespace(default_workspace="D:/pets")),
    )
    body = _client().get("/internal/agent-config", headers=_HEADER).json()
    assert body == {"defaultWorkspace": "D:/pets", "thinkingLevel": "high"}


def test_get_marks_broken_config(monkeypatch: pytest.MonkeyPatch) -> None:
    def boom() -> None:
        raise ValueError("broken")

    monkeypatch.setattr(config_module, "load_config", boom)
    body = _client().get("/internal/agent-config", headers=_HEADER).json()
    assert body == {
        "defaultWorkspace": "",
        "thinkingLevel": "high",
        "configError": True,
    }


def test_post_saves_workspace(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    config = AppConfig()
    saved: list[AppConfig] = []
    monkeypatch.setattr(config_module, "load_config", lambda: config)
    monkeypatch.setattr(config_module, "save_config", lambda value: saved.append(value))

    body = _client().post(
        "/internal/agent-config",
        json={"defaultWorkspace": str(workspace)},
        headers=_HEADER,
    ).json()

    assert body == {
        "ok": True,
        "defaultWorkspace": str(workspace),
        "thinkingLevel": "high",
    }
    assert len(saved) == 1
    assert saved[0].agent.default_workspace == str(workspace)


def test_post_saves_thinking_level(monkeypatch: pytest.MonkeyPatch) -> None:
    config = AppConfig()
    saved: list[AppConfig] = []
    monkeypatch.setattr(config_module, "load_config", lambda: config)
    monkeypatch.setattr(config_module, "save_config", lambda value: saved.append(value))

    body = _client().post(
        "/internal/agent-config", json={"thinkingLevel": "max"}, headers=_HEADER
    ).json()

    assert body == {"ok": True, "defaultWorkspace": "", "thinkingLevel": "max"}
    assert len(saved) == 1
    assert saved[0].agent.thinking_level == "max"


def test_post_rejects_invalid_thinking_level(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(config_module, "load_config", lambda: AppConfig())
    body = _client().post(
        "/internal/agent-config", json={"thinkingLevel": "medium"}, headers=_HEADER
    ).json()
    assert body["ok"] is False
    assert body["code"] == "INVALID_THINKING"


def test_post_clears_workspace(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    config = AppConfig()
    config.agent.default_workspace = "D:/old"
    saved: list[AppConfig] = []
    monkeypatch.setattr(config_module, "load_config", lambda: config)
    monkeypatch.setattr(config_module, "save_config", lambda value: saved.append(value))

    body = _client().post(
        "/internal/agent-config", json={"defaultWorkspace": ""}, headers=_HEADER
    ).json()

    assert body["ok"] is True
    assert saved[0].agent.default_workspace == ""


def test_post_rejects_relative_path(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(config_module, "load_config", lambda: AppConfig())
    body = _client().post(
        "/internal/agent-config", json={"defaultWorkspace": "relative/dir"}, headers=_HEADER
    ).json()
    assert body["ok"] is False
    assert body["code"] == "INVALID_PATH"


def test_post_rejects_missing_directory(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(config_module, "load_config", lambda: AppConfig())
    body = _client().post(
        "/internal/agent-config",
        json={"defaultWorkspace": str(tmp_path / "nope")},
        headers=_HEADER,
    ).json()
    assert body["ok"] is False
    assert "不存在" in body["message"]
