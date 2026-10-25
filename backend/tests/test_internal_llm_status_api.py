"""内部模型/余额端点单测（2026-10-25）。"""

from __future__ import annotations

from types import SimpleNamespace

import httpx
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


def _patch_llm(
    monkeypatch: pytest.MonkeyPatch,
    *,
    key: str = "sk-test",
    base_url: str = "https://api.deepseek.com/v1",
    model: str = "deepseek-flash",
    show_balance: bool = True,
    show_model: bool = True,
    show_cost: bool = True,
) -> None:
    monkeypatch.setattr(secrets_module, "get_llm_key", lambda: key)
    agent = SimpleNamespace(
        show_balance=show_balance,
        show_model=show_model,
        show_cost=show_cost,
        thinking_level="high",
    )
    monkeypatch.setattr(
        config_module,
        "load_config",
        lambda: SimpleNamespace(
            llm=SimpleNamespace(base_url=base_url, model=model), agent=agent
        ),
    )


class _FakeResponse:
    def __init__(self, status_code: int = 200, data: object = None, bad_json: bool = False):
        self.status_code = status_code
        self._data = data
        self._bad_json = bad_json

    def json(self) -> object:
        if self._bad_json:
            raise ValueError("bad json")
        return self._data


def _patch_httpx(
    monkeypatch: pytest.MonkeyPatch,
    *,
    response: _FakeResponse | None = None,
    error: Exception | None = None,
    seen: list[str] | None = None,
) -> None:
    class FakeClient:
        def __init__(self, *args: object, **kwargs: object) -> None:
            pass

        async def __aenter__(self) -> "FakeClient":
            return self

        async def __aexit__(self, *exc: object) -> bool:
            return False

        async def get(self, url: str, headers: dict[str, str] | None = None) -> _FakeResponse:
            if seen is not None:
                seen.append(url)
            if error is not None:
                raise error
            assert response is not None
            return response

    monkeypatch.setattr(httpx, "AsyncClient", FakeClient)


def _body(**overrides: object) -> dict[str, object]:
    base: dict[str, object] = {
        "configured": True,
        "model": "deepseek-flash",
        "showBalance": True,
        "showModel": True,
        "showCost": True,
        "thinkingLevel": "high",
        "balanceSupported": True,
        "currency": "",
        "total": None,
        "granted": None,
        "toppedUp": None,
        "code": "",
        "message": "",
    }
    base.update(overrides)
    return base


def test_rejects_missing_token() -> None:
    assert _client(token=None).get("/internal/llm-status").status_code == 403


def test_show_balance_off_skips_request(monkeypatch: pytest.MonkeyPatch) -> None:
    _patch_llm(monkeypatch, show_balance=False)
    seen: list[str] = []
    _patch_httpx(monkeypatch, seen=seen)
    body = _client().get("/internal/llm-status", headers=_HEADER).json()
    assert body == _body(showBalance=False, balanceSupported=False)
    assert seen == []


def test_missing_key(monkeypatch: pytest.MonkeyPatch) -> None:
    _patch_llm(monkeypatch, key="")
    body = _client().get("/internal/llm-status", headers=_HEADER).json()
    assert body == _body(
        configured=False,
        balanceSupported=False,
        code="no_key",
        message="还没有配置聊天模型",
    )


def test_custom_endpoint_skips_balance(monkeypatch: pytest.MonkeyPatch) -> None:
    _patch_llm(monkeypatch, base_url="https://my-proxy.example.com/v1")
    seen: list[str] = []
    _patch_httpx(monkeypatch, seen=seen)
    body = _client().get("/internal/llm-status", headers=_HEADER).json()
    assert body == _body(
        balanceSupported=False,
        code="custom_endpoint",
        message="自定义端点不支持查询余额",
    )
    assert seen == []


def test_official_balance_prefers_cny(monkeypatch: pytest.MonkeyPatch) -> None:
    _patch_llm(monkeypatch)
    seen: list[str] = []
    _patch_httpx(
        monkeypatch,
        seen=seen,
        response=_FakeResponse(
            data={
                "is_available": True,
                "balance_infos": [
                    {"currency": "USD", "total_balance": "10.00"},
                    {
                        "currency": "CNY",
                        "total_balance": "98.21",
                        "granted_balance": "8.21",
                        "topped_up_balance": "90.00",
                    },
                ],
            }
        ),
    )
    body = _client().get("/internal/llm-status", headers=_HEADER).json()
    assert body == _body(currency="CNY", total=98.21, granted=8.21, toppedUp=90.0)
    assert seen == ["https://api.deepseek.com/user/balance"]


def test_http_error_keeps_supported_flag(monkeypatch: pytest.MonkeyPatch) -> None:
    _patch_llm(monkeypatch)
    _patch_httpx(monkeypatch, response=_FakeResponse(status_code=500))
    body = _client().get("/internal/llm-status", headers=_HEADER).json()
    assert body == _body(code="http_error", message="余额查询失败（HTTP 500）")


def test_network_error(monkeypatch: pytest.MonkeyPatch) -> None:
    _patch_llm(monkeypatch)
    _patch_httpx(monkeypatch, error=httpx.ConnectError("boom"))
    body = _client().get("/internal/llm-status", headers=_HEADER).json()
    assert body == _body(code="network", message="连不上 DeepSeek 余额接口")


def test_timeout(monkeypatch: pytest.MonkeyPatch) -> None:
    _patch_llm(monkeypatch)
    _patch_httpx(monkeypatch, error=httpx.ReadTimeout("slow"))
    body = _client().get("/internal/llm-status", headers=_HEADER).json()
    assert body == _body(code="timeout", message="余额查询超时")


def test_empty_or_broken_response(monkeypatch: pytest.MonkeyPatch) -> None:
    _patch_llm(monkeypatch)
    _patch_httpx(monkeypatch, response=_FakeResponse(data={"balance_infos": []}))
    body = _client().get("/internal/llm-status", headers=_HEADER).json()
    assert body == _body(code="bad_response", message="余额响应为空")

    _patch_httpx(monkeypatch, response=_FakeResponse(bad_json=True))
    body = _client().get("/internal/llm-status", headers=_HEADER).json()
    assert body == _body(code="bad_response", message="余额响应解析失败")
