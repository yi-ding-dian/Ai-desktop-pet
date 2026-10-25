"""内部文件读取端点单测（任务模式复用对话附件的读取与限额，2026-10-25）。"""

from __future__ import annotations

from types import SimpleNamespace
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

import backend.shared.config as config_module
from backend.interfaces.ws.server import create_app

_INTERNAL = "internal-token-for-test"
_HEADER = {"X-Pet-Internal-Token": _INTERNAL}


def _client(token: str | None = _INTERNAL) -> TestClient:
    app = create_app(dispatcher=object(), app_version="test", internal_token=token)  # type: ignore[arg-type]
    return TestClient(app)


def _patch_files_config(monkeypatch: pytest.MonkeyPatch, **overrides: int | bool) -> None:
    values = {
        "max_chars": 20_000,
        "max_bytes": 1024 * 1024,
        "max_per_turn": 3,
        "max_image_bytes": 1024 * 1024,
        "allow_images": True,
    }
    values.update(overrides)
    monkeypatch.setattr(
        config_module, "load_config", lambda: SimpleNamespace(files=SimpleNamespace(**values))
    )


def test_rejects_missing_token() -> None:
    resp = _client(token=None).post("/internal/files/extract", json={"paths": ["x"]})
    assert resp.status_code == 403


def test_rejects_bad_payload() -> None:
    resp = _client().post("/internal/files/extract", json={"paths": []}, headers=_HEADER)
    assert resp.status_code == 200
    assert resp.json()["ok"] is False
    assert resp.json()["code"] == "INVALID_PATH"


def test_reads_text_file(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _patch_files_config(monkeypatch)
    path = tmp_path / "hello.py"
    path.write_text("print(1)\n", encoding="utf-8")

    body = _client().post(
        "/internal/files/extract", json={"paths": [str(path)]}, headers=_HEADER
    ).json()

    assert body["ok"] is True
    assert body["files"][0]["name"] == "hello.py"
    assert body["files"][0]["text"] == "print(1)\n"
    assert body["files"][0]["chars"] == 9
    assert body["files"][0]["imageUrl"] is None


def test_missing_file_returns_readable_error(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _patch_files_config(monkeypatch)
    body = _client().post(
        "/internal/files/extract",
        json={"paths": [str(tmp_path / "nope.txt")]},
        headers=_HEADER,
    ).json()

    assert body["ok"] is False
    assert body["code"] == "NOT_FOUND"
    assert "找不到文件" in body["message"]


def test_too_many_files_uses_config_limit(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _patch_files_config(monkeypatch, max_per_turn=1)
    first = tmp_path / "a.txt"
    second = tmp_path / "b.txt"
    first.write_text("a", encoding="utf-8")
    second.write_text("b", encoding="utf-8")

    body = _client().post(
        "/internal/files/extract",
        json={"paths": [str(first), str(second)]},
        headers=_HEADER,
    ).json()

    assert body["ok"] is False
    assert body["code"] == "TOO_MANY_FILES"
