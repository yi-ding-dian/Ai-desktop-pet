"""内部 LLM Key 端点单测（任务模式复用聊天 Key，2026-10-23）。

覆盖：
- 无 token / 错 token / 未注入内部 token → 403；
- 正确 token → 200，返回 key/baseUrl/model 且带 no-store；
- 未配置 Key → configured=false（仍可被调用，交给主进程提示去设置）。
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

import backend.shared.config as config_module
import backend.shared.secrets as secrets_module
from backend.interfaces.ws.server import create_app

_INTERNAL = "internal-token-for-test"
_HEADER = {"X-Pet-Internal-Token": _INTERNAL}


def _client(token: str | None = _INTERNAL) -> TestClient:
    app = create_app(dispatcher=object(), app_version="test", internal_token=token)  # type: ignore[arg-type]
    return TestClient(app)


@pytest.fixture
def configured(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        config_module,
        "load_config",
        lambda: SimpleNamespace(
            llm=SimpleNamespace(base_url="https://api.deepseek.com", model="deepseek-flash")
        ),
    )
    monkeypatch.setattr(secrets_module, "get_llm_key", lambda: "sk-test-key")


def test_rejects_missing_token() -> None:
    resp = _client().get("/internal/llm-key")
    assert resp.status_code == 403


def test_rejects_wrong_token() -> None:
    resp = _client().get("/internal/llm-key", headers={"X-Pet-Internal-Token": "nope"})
    assert resp.status_code == 403


def test_disabled_when_token_not_injected(configured: None) -> None:
    resp = _client(token=None).get("/internal/llm-key", headers=_HEADER)
    assert resp.status_code == 403


def test_returns_key_and_model(configured: None) -> None:
    resp = _client().get("/internal/llm-key", headers=_HEADER)
    assert resp.status_code == 200
    assert resp.headers["cache-control"] == "no-store"
    body = resp.json()
    assert body == {
        "configured": True,
        "key": "sk-test-key",
        "baseUrl": "https://api.deepseek.com",
        "model": "deepseek-flash",
    }


def test_unconfigured_key(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(secrets_module, "get_llm_key", lambda: None)
    monkeypatch.setattr(
        config_module,
        "load_config",
        lambda: SimpleNamespace(llm=SimpleNamespace(base_url="", model="")),
    )
    body = _client().get("/internal/llm-key", headers=_HEADER).json()
    assert body["configured"] is False
    assert body["key"] == ""
