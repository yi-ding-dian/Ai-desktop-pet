"""内部 HTTP 端点单测（2026-10-23）：编码代理从主进程取 LLM Key。

只测鉴权与返回形状，不碰真实 keyring。
"""

from __future__ import annotations

from types import SimpleNamespace

from fastapi.testclient import TestClient

from backend.interfaces.ws import server


def _stub_config(monkeypatch, base_url: str = "https://api.deepseek.com/v1") -> None:
    monkeypatch.setattr(
        server,
        "load_config",
        lambda: SimpleNamespace(llm=SimpleNamespace(base_url=base_url)),
    )


def _client(token: str | None = "tok") -> TestClient:
    app = server.create_app(dispatcher=object(), app_version="test", internal_token=token)  # type: ignore[arg-type]
    return TestClient(app)


def test_internal_key_requires_token() -> None:
    client = _client("secret")
    assert client.get("/internal/llm-key").status_code == 403
    assert (
        client.get("/internal/llm-key", headers={"X-Pet-Internal-Token": "wrong"}).status_code
        == 403
    )


def test_internal_key_returns_key_for_valid_token(monkeypatch) -> None:
    monkeypatch.setattr(server, "get_llm_key", lambda: "sk-test-123456")
    _stub_config(monkeypatch)
    response = _client("secret").get(
        "/internal/llm-key", headers={"X-Pet-Internal-Token": "secret"}
    )
    assert response.status_code == 200
    assert response.json() == {
        "configured": True,
        "key": "sk-test-123456",
        "baseUrl": "https://api.deepseek.com/v1",
    }
    assert response.headers.get("cache-control") == "no-store"


def test_internal_key_reports_missing_key(monkeypatch) -> None:
    monkeypatch.setattr(server, "get_llm_key", lambda: None)
    _stub_config(monkeypatch)
    response = _client("secret").get(
        "/internal/llm-key", headers={"X-Pet-Internal-Token": "secret"}
    )
    assert response.status_code == 200
    assert response.json() == {
        "configured": False,
        "key": None,
        "baseUrl": "https://api.deepseek.com/v1",
    }


def test_internal_key_disabled_without_configured_token() -> None:
    app = server.create_app(dispatcher=object(), app_version="test", internal_token=None)  # type: ignore[arg-type]
    client = TestClient(app)
    assert client.get("/internal/llm-key").status_code == 403
