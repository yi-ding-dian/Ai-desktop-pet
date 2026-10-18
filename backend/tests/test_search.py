"""联网搜索单测（2026-10-18）：DeepSeek Search/Fetch provider + SearchService。

覆盖：
- SearchService 开关、成功/空结果/失败/抓取成功与截断的 model_content；
- DeepSeek provider：请求 URL/鉴权/字段、响应解析、401 翻译、429 重试一次、
  Fetch URL 校验与正文截断；
- 格式化：编号来源、不可信内容提示、总量截断。
"""

from __future__ import annotations

import asyncio
import json
from typing import Any

import httpx
import pytest

from backend.application.search_service import SearchService
from backend.modules.llm.openai_compat import _message_payload
from backend.modules.llm.provider import ChatMessage
from backend.modules.search.deepseek import DeepSeekSearchProvider, _endpoint
from backend.modules.search.format import MAX_MODEL_CHARS, format_search_for_model
from backend.modules.search.provider import (
    FetchOutcome,
    SearchOutcome,
    SearchResult,
)
from backend.shared.config import SearchConfig


def make_config(**overrides: Any) -> SearchConfig:
    data: dict[str, Any] = {
        "enabled": True,
        "base_url": "https://api.deepseek.com",
        "count": 5,
        "need_content": False,
        "timeout_seconds": 5,
        "max_fetch_chars": 6000,
    }
    data.update(overrides)
    return SearchConfig(**data)


class FakeProvider:
    def __init__(
        self,
        *,
        search_outcome: SearchOutcome | None = None,
        fetch_outcome: FetchOutcome | None = None,
    ) -> None:
        self.search_outcome = search_outcome
        self.fetch_outcome = fetch_outcome
        self.search_calls: list[dict[str, Any]] = []
        self.fetch_calls: list[dict[str, Any]] = []

    async def search(self, query: str, **kwargs: Any) -> SearchOutcome:
        self.search_calls.append({"query": query, **kwargs})
        assert self.search_outcome is not None
        return self.search_outcome

    async def fetch(self, url: str, *, max_chars: int) -> FetchOutcome:
        self.fetch_calls.append({"url": url, "max_chars": max_chars})
        assert self.fetch_outcome is not None
        return self.fetch_outcome


def result(index: int = 1) -> SearchResult:
    return SearchResult(
        title=f"标题{index}",
        url=f"https://example.com/{index}",
        snippet="短摘要",
        summary=f"长摘要{index}",
        date="2026-10-18T00:00:00Z",
        authority=3,
        rerank_score=2.4,
    )


# ---------------------------------------------------------------- SearchService


def test_search_service_disabled() -> None:
    provider = FakeProvider(search_outcome=SearchOutcome(True, "search_ok", "", (result(),)))
    service = SearchService(provider, config=lambda: make_config(enabled=False))
    out = asyncio.run(service.search_from_tool({"query": "测试"}, "测试一下"))
    assert out["ok"] is False
    assert out["code"] == "search_disabled"
    assert "未开启" in out["model_content"]
    assert provider.search_calls == []


def test_search_service_success_formats_model_content() -> None:
    provider = FakeProvider(
        search_outcome=SearchOutcome(True, "search_ok", "找到 2 条结果", (result(1), result(2)))
    )
    service = SearchService(provider, config=lambda: make_config(count=7))
    out = asyncio.run(service.search_from_tool({"query": "DeepSeek V4"}, "DeepSeek V4 发布了吗"))
    assert out["ok"] is True
    assert out["message"] == "已联网搜索：2 条结果"
    content = out["model_content"]
    assert "[1]" in content and "https://example.com/1" in content
    assert "长摘要1" in content and "用户原问题" in content
    assert "不可信" in content and "不要编造" in content
    # count 缺省用配置；ori_question 用用户原话；need_content 用配置
    assert provider.search_calls[0]["count"] == 7
    assert provider.search_calls[0]["ori_question"] == "DeepSeek V4 发布了吗"
    assert provider.search_calls[0]["need_content"] is False


def test_search_service_empty_and_error() -> None:
    empty = FakeProvider(search_outcome=SearchOutcome(True, "search_empty", "没有找到相关结果", ()))
    service = SearchService(empty, config=make_config)
    out = asyncio.run(service.search_from_tool({"query": "没有的东西"}, "搜一下"))
    assert out["ok"] is True and out["code"] == "search_empty"
    assert "没有找到" in out["model_content"]

    failed = FakeProvider(
        search_outcome=SearchOutcome(False, "search_failed", "DeepSeek 账户余额不足", ())
    )
    service = SearchService(failed, config=make_config)
    out = asyncio.run(service.search_from_tool({"query": "x"}, "搜一下"))
    assert out["ok"] is False
    assert out["message"] == "DeepSeek 账户余额不足"
    assert "联网搜索失败" in out["model_content"]
    assert "不要编造" in out["model_content"]


def test_fetch_service_success_and_error() -> None:
    ok = FakeProvider(
        fetch_outcome=FetchOutcome(
            True, "fetch_ok", "已抓取网页：页面", title="页面", content="# 正文", truncated=True
        )
    )
    service = SearchService(ok, config=lambda: make_config(max_fetch_chars=1234))
    out = asyncio.run(service.fetch_from_tool({"url": "https://example.com/a"}))
    assert out["ok"] is True
    assert "已抓取网页" in out["message"]
    assert "https://example.com/a" in out["model_content"]
    assert "# 正文" in out["model_content"]
    assert "只保留了前一部分" in out["model_content"]
    assert ok.fetch_calls[0]["max_chars"] == 1234

    failed = FakeProvider(
        fetch_outcome=FetchOutcome(False, "fetch_failed", "没有抓到可用的网页内容")
    )
    service = SearchService(failed, config=make_config)
    out = asyncio.run(service.fetch_from_tool({"url": "https://example.com/a"}))
    assert out["ok"] is False
    assert "网页抓取失败" in out["model_content"]


def test_format_search_caps_total_chars() -> None:
    many = [
        SearchResult(
            title=f"T{i}",
            url=f"https://example.com/{i}",
            summary="很长" * 900,
        )
        for i in range(20)
    ]
    block = format_search_for_model("q", many)
    assert len(block) < MAX_MODEL_CHARS + 2000
    assert "还有" in block
    assert "不可信" in block


# ---------------------------------------------------------------- DeepSeek provider


def test_endpoint_normalizes_v1() -> None:
    assert (
        _endpoint("https://api.deepseek.com", "/v1/tools/search")
        == "https://api.deepseek.com/v1/tools/search"
    )
    assert (
        _endpoint("https://api.deepseek.com/v1/", "/v1/tools/search")
        == "https://api.deepseek.com/v1/tools/search"
    )


def test_deepseek_search_request_and_parse(monkeypatch: pytest.MonkeyPatch) -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(
            200,
            json={
                "results": [
                    {
                        "title": "标题",
                        "url": "https://example.com/a",
                        "snippet": "短",
                        "summary": "长",
                        "content": "",
                        "site_name": "站点",
                        "date": "2026-10-18T00:00:00Z",
                        "authority": 3,
                        "rerank_score": 2.4,
                    }
                ]
            },
        )

    provider = DeepSeekSearchProvider(
        config=lambda: make_config(),
        key_provider=lambda: "test-key",
        transport=httpx.MockTransport(handler),
    )
    out = asyncio.run(
        provider.search("DeepSeek V4", count=3, ori_question="V4 发布了吗")
    )
    assert out.ok and len(out.results) == 1
    assert out.results[0].authority == 3
    assert out.results[0].rerank_score == 2.4
    assert len(seen) == 1
    request = seen[0]
    assert request.url.path == "/v1/tools/search"
    assert request.headers["authorization"] == "Bearer test-key"
    body = json.loads(request.content)
    assert body == {
        "query": "DeepSeek V4",
        "count": 3,
        "need_content": False,
        "ori_question": "V4 发布了吗",
    }


def test_deepseek_maps_401(monkeypatch: pytest.MonkeyPatch) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            401,
            json={
                "error": {
                    "message": "Authentication Fails",
                    "type": "invalid_request_error",
                    "param": None,
                    "code": "invalid_request_error",
                }
            },
        )

    provider = DeepSeekSearchProvider(
        config=lambda: make_config(),
        key_provider=lambda: "bad-key",
        transport=httpx.MockTransport(handler),
    )
    out = asyncio.run(provider.search("x", count=1))
    assert out.ok is False
    assert "API Key 无效" in out.message
    assert "Authentication Fails" in out.message


def test_deepseek_retries_429_once(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        "backend.modules.search.deepseek._RETRY_DELAY_SECONDS", 0.01
    )
    calls = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        if calls["n"] == 1:
            return httpx.Response(429, json={"error": {"message": "rate limited"}})
        return httpx.Response(200, json={"results": [{"title": "t", "url": "https://x"}]})

    provider = DeepSeekSearchProvider(
        config=lambda: make_config(),
        key_provider=lambda: "k",
        transport=httpx.MockTransport(handler),
    )
    out = asyncio.run(provider.search("x", count=1))
    assert out.ok is True
    assert calls["n"] == 2


def test_deepseek_fetch_parse_and_truncate() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/v1/tools/fetch"
        return httpx.Response(
            200, json={"title": "页面", "content": "a" * 2000}
        )

    provider = DeepSeekSearchProvider(
        config=lambda: make_config(max_fetch_chars=1000),
        key_provider=lambda: "k",
        transport=httpx.MockTransport(handler),
    )
    out = asyncio.run(provider.fetch("https://example.com/a", max_chars=1000))
    assert out.ok is True
    assert out.title == "页面"
    assert out.truncated is True
    assert len(out.content) == 1000


def test_deepseek_fetch_rejects_bad_url_without_request() -> None:
    provider = DeepSeekSearchProvider(
        config=lambda: make_config(),
        key_provider=lambda: "k",
        transport=httpx.MockTransport(lambda request: httpx.Response(500)),
    )
    for url in ("ftp://example.com/a", "https://user:pass@example.com/a", "not-a-url"):
        out = asyncio.run(provider.fetch(url, max_chars=1000))
        assert out.ok is False
        assert out.code == "fetch_bad_url"


# ---------------------------------------------------------------- tool 消息序列化


def test_message_payload_supports_tool_messages() -> None:
    assistant = ChatMessage(
        role="assistant",
        content="",
        tool_calls=(
            {
                "id": "call_1",
                "type": "function",
                "function": {"name": "web_search", "arguments": '{"query":"x"}'},
            },
        ),
    )
    payload = _message_payload(assistant)
    assert payload["role"] == "assistant"
    assert payload["tool_calls"][0]["id"] == "call_1"

    tool = ChatMessage(role="tool", content="结果", tool_call_id="call_1")
    assert _message_payload(tool) == {
        "role": "tool",
        "content": "结果",
        "tool_call_id": "call_1",
    }

    # 普通消息保持旧格式
    assert _message_payload(ChatMessage(role="user", content="hi")) == {
        "role": "user",
        "content": "hi",
    }
