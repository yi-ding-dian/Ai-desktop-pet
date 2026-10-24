"""内部联网搜索端点单测（任务模式复用 SearchService，2026-10-24）。

覆盖：
- 无/错 token → 403；未装配 SearchService → 503；
- 成功回执转成驼峰契约（modelContent + no-store），参数原样交给 SearchService；
- 「设置 → 搜索」关闭时把 search_disabled 原样回给主进程，端点不吞。
"""

from __future__ import annotations

from typing import Any

from fastapi.testclient import TestClient

from backend.interfaces.ws.server import create_app

_INTERNAL = "internal-token-for-test"
_HEADER = {"X-Pet-Internal-Token": _INTERNAL}


class FakeSearch:
    def __init__(
        self,
        *,
        search_result: dict[str, Any] | None = None,
        fetch_result: dict[str, Any] | None = None,
    ) -> None:
        self.search_result = search_result or {
            "ok": True,
            "code": "search_ok",
            "message": "已联网搜索：2 条结果",
            "model_content": "[联网搜索结果] 查询：天气\n1. 标题 https://example.com",
            "sources": [
                {
                    "index": 1,
                    "title": "标题",
                    "url": "https://example.com",
                    "snippet": "摘要",
                    "site_name": "示例站",
                    "date": "2026-10-24",
                }
            ],
        }
        self.fetch_result = fetch_result or {
            "ok": True,
            "code": "fetch_ok",
            "message": "已抓取网页：示例",
            "model_content": "示例正文",
            "sources": [],
        }
        self.search_calls: list[dict[str, Any]] = []
        self.fetch_calls: list[dict[str, Any]] = []

    async def search_from_tool(
        self, args: dict[str, Any], user_text: str = ""
    ) -> dict[str, Any]:
        self.search_calls.append({"args": args, "user_text": user_text})
        return self.search_result

    async def fetch_from_tool(self, args: dict[str, Any]) -> dict[str, Any]:
        self.fetch_calls.append(args)
        return self.fetch_result


def _client(
    *, token: str | None = _INTERNAL, search: Any = None
) -> TestClient:
    app = create_app(
        dispatcher=object(),  # type: ignore[arg-type]
        app_version="test",
        internal_token=token,
        search=search,
    )
    return TestClient(app)


def test_rejects_missing_token() -> None:
    resp = _client(search=FakeSearch()).post("/internal/search", json={"query": "天气"})
    assert resp.status_code == 403


def test_rejects_wrong_token() -> None:
    resp = _client(search=FakeSearch()).post(
        "/internal/search",
        json={"query": "天气"},
        headers={"X-Pet-Internal-Token": "nope"},
    )
    assert resp.status_code == 403


def test_returns_503_when_search_not_wired() -> None:
    resp = _client().post("/internal/search", json={"query": "天气"}, headers=_HEADER)
    assert resp.status_code == 503
    resp = _client().post(
        "/internal/fetch", json={"url": "https://example.com"}, headers=_HEADER
    )
    assert resp.status_code == 503


def test_search_returns_camel_case_contract() -> None:
    fake = FakeSearch()
    resp = _client(search=fake).post(
        "/internal/search", json={"query": "天气"}, headers=_HEADER
    )
    assert resp.status_code == 200
    assert resp.headers["cache-control"] == "no-store"
    assert resp.json() == {
        "ok": True,
        "code": "search_ok",
        "message": "已联网搜索：2 条结果",
        "modelContent": "[联网搜索结果] 查询：天气\n1. 标题 https://example.com",
        # 结构化来源原样带过去，任务面板的悬浮卡片与对话模式共用
        "sources": [
            {
                "index": 1,
                "title": "标题",
                "url": "https://example.com",
                "snippet": "摘要",
                "site_name": "示例站",
                "date": "2026-10-24",
            }
        ],
    }
    assert fake.search_calls == [{"args": {"query": "天气"}, "user_text": ""}]


def test_search_disabled_passthrough() -> None:
    fake = FakeSearch(
        search_result={
            "ok": False,
            "code": "search_disabled",
            "message": "联网搜索还没开，去设置 → 搜索里打开开关～",
            "model_content": "[联网搜索未开启] 请告诉用户去设置里打开开关。",
        }
    )
    body = _client(search=fake).post(
        "/internal/search", json={"query": "天气"}, headers=_HEADER
    ).json()
    assert body["ok"] is False
    assert body["code"] == "search_disabled"
    assert "设置" in body["modelContent"]


def test_bad_shapes_become_empty_strings() -> None:
    fake = FakeSearch()
    client = _client(search=fake)
    client.post("/internal/search", json={"query": 42}, headers=_HEADER)
    client.post("/internal/fetch", json={"url": None}, headers=_HEADER)
    assert fake.search_calls == [{"args": {"query": ""}, "user_text": ""}]
    assert fake.fetch_calls == [{"url": ""}]


def test_fetch_returns_camel_case_contract() -> None:
    fake = FakeSearch()
    resp = _client(search=fake).post(
        "/internal/fetch", json={"url": "https://example.com"}, headers=_HEADER
    )
    assert resp.status_code == 200
    assert resp.json()["modelContent"] == "示例正文"
    assert fake.fetch_calls == [{"url": "https://example.com"}]
