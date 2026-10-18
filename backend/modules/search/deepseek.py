"""DeepSeek Search / Fetch 实现（2026-10-18）。

官方接口（与对话 API 同一 Bearer Key，独立的原始 JSON 端点）：

- ``POST https://api.deepseek.com/v1/tools/search``
- ``POST https://api.deepseek.com/v1/tools/fetch``

计费：Search / Fetch 各 ¥5 / 1000 次**成功**请求；失败/无结果/超时不计费；
北京时间 2026-11-01 00:00 起计费；每个账号两个端点各 5 QPS。
本文件只做 HTTP 调用与错误翻译；开关/格式化/工具编排在 application 层。
"""

from __future__ import annotations

import asyncio
import time
from typing import Any, Callable
from urllib.parse import urlsplit

import httpx
from loguru import logger

from backend.modules.search.provider import (
    FetchOutcome,
    SearchOutcome,
    SearchProvider,
    SearchResult,
)
from backend.shared.config import SearchConfig
from backend.shared.secrets import get_llm_key

#: Search / Fetch 各自 5 QPS；留一点余量，避免卡在边界
_MIN_INTERVAL_SECONDS = 0.21
#: 官方建议 408/429/5xx 等待后重试；只重试一次
_RETRYABLE_STATUS = frozenset({408, 429, 500, 502, 503, 504})
_RETRY_DELAY_SECONDS = 0.6
#: 错误消息里最多附带多少字的官方说明
_API_MESSAGE_LIMIT = 200

_STATUS_MESSAGES = {
    400: "搜索/抓取请求不合法",
    401: "DeepSeek API Key 无效或未配置",
    402: "DeepSeek 账户余额不足",
    403: "抓取被目标站点或安全策略拒绝",
    404: "没有抓到可用的网页内容",
    408: "请求超时",
    413: "请求内容过大",
    429: "请求太频繁（Search / Fetch 各 5 QPS）",
    500: "DeepSeek 搜索服务内部错误",
    504: "DeepSeek 下游请求超时",
}


class DeepSeekSearchProvider(SearchProvider):
    """DeepSeek 官方 Search / Fetch 客户端（无状态、可复用）。"""

    def __init__(
        self,
        config: Callable[[], SearchConfig],
        *,
        key_provider: Callable[[], str | None] = get_llm_key,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self._config = config
        self._key_provider = key_provider
        #: 测试注入（httpx.MockTransport）；生产为 None，走真实网络
        self._transport = transport
        self._throttle_lock = asyncio.Lock()
        self._last_call = 0.0

    # ---------------------------------------------------------------- 对外

    async def search(
        self,
        query: str,
        *,
        count: int,
        ori_question: str | None = None,
        need_content: bool = False,
    ) -> SearchOutcome:
        cfg = self._config()
        text = (query or "").strip()
        if not text:
            return SearchOutcome(False, "search_bad_query", "搜索词不能为空")
        if len(text) > 128:
            text = text[:128]
        payload: dict[str, Any] = {
            "query": text,
            "count": max(1, min(50, int(count))),
            "need_content": bool(need_content),
        }
        if ori_question and ori_question.strip():
            payload["ori_question"] = ori_question.strip()[:128]

        status, data, error = await self._post(cfg, "/v1/tools/search", payload)
        if error:
            return SearchOutcome(False, "search_failed", error)

        results = _parse_results(data)
        if not results:
            return SearchOutcome(True, "search_empty", "没有找到相关结果", ())
        logger.debug("DeepSeek Search 完成：status={} results={}", status, len(results))
        return SearchOutcome(
            True, "search_ok", f"找到 {len(results)} 条结果", results
        )

    async def fetch(self, url: str, *, max_chars: int) -> FetchOutcome:
        cfg = self._config()
        text = (url or "").strip()
        problem = _validate_fetch_url(text)
        if problem:
            return FetchOutcome(False, "fetch_bad_url", problem)

        status, data, error = await self._post(cfg, "/v1/tools/fetch", {"url": text})
        if error:
            return FetchOutcome(False, "fetch_failed", error)

        title = str(data.get("title") or "") if isinstance(data, dict) else ""
        content = str(data.get("content") or "") if isinstance(data, dict) else ""
        if not content.strip():
            return FetchOutcome(
                False,
                "fetch_empty",
                "没有抓到可用的网页内容（页面可能被拦截、需要登录，或没有正文）",
            )
        limit = max(1_000, min(50_000, int(max_chars)))
        truncated = len(content) > limit
        if truncated:
            content = content[:limit]
        logger.debug(
            "DeepSeek Fetch 完成：status={} title={!r} chars={} truncated={}",
            status,
            title[:60],
            len(content),
            truncated,
        )
        return FetchOutcome(
            True,
            "fetch_ok",
            f"已抓取网页：{title or text}",
            title=title,
            content=content,
            truncated=truncated,
        )

    # ---------------------------------------------------------------- HTTP

    async def _post(
        self, cfg: SearchConfig, path: str, payload: dict[str, Any]
    ) -> tuple[int, dict[str, Any] | None, str]:
        """发一次请求；返回 ``(status, json, error_message)``（error 为空表示成功）。"""
        key = str(self._key_provider() or "").strip()
        if not key:
            return 0, None, "还没有配置 DeepSeek API Key（设置 → LLM 里填）"
        url = _endpoint(cfg.base_url, path)
        headers = {
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
            "Accept": "application/json",
        }

        async with httpx.AsyncClient(
            timeout=float(cfg.timeout_seconds), transport=self._transport
        ) as client:
            response: httpx.Response | None = None
            for attempt in range(2):
                await self._throttle()
                try:
                    response = await client.post(url, headers=headers, json=payload)
                except httpx.TimeoutException:
                    return 0, None, f"请求超时（{cfg.timeout_seconds} 秒）"
                except httpx.RequestError as exc:
                    # 不把底层异常原文整段抛给用户；类名足够定位网络问题
                    logger.warning("DeepSeek Search 网络错误：{}", exc.__class__.__name__)
                    return 0, None, "连不上 DeepSeek 搜索服务（网络或代理问题）"
                if (
                    response.status_code in _RETRYABLE_STATUS
                    and attempt == 0
                ):
                    logger.info(
                        "DeepSeek Search 返回 {}，{:.1f}s 后重试一次",
                        response.status_code,
                        _RETRY_DELAY_SECONDS,
                    )
                    await asyncio.sleep(_RETRY_DELAY_SECONDS)
                    continue
                break

        assert response is not None
        if response.status_code != 200:
            api_message = _api_error_message(response)
            friendly = _STATUS_MESSAGES.get(
                response.status_code, f"联网搜索失败（HTTP {response.status_code}）"
            )
            if api_message:
                friendly = f"{friendly}：{api_message[:_API_MESSAGE_LIMIT]}"
            logger.warning(
                "DeepSeek Search 请求失败：status={} message={}",
                response.status_code,
                friendly,
            )
            return response.status_code, None, friendly

        try:
            data = response.json()
        except ValueError:
            return response.status_code, None, "搜索服务返回了无法解析的结果"
        if not isinstance(data, dict):
            return response.status_code, None, "搜索服务返回了无法识别的结果"
        return response.status_code, data, ""

    async def _throttle(self) -> None:
        """账号级 5 QPS：任意两次请求之间至少间隔 0.21s。"""
        async with self._throttle_lock:
            now = time.monotonic()
            wait = _MIN_INTERVAL_SECONDS - (now - self._last_call)
            if wait > 0:
                await asyncio.sleep(wait)
            self._last_call = time.monotonic()


# ---------------------------------------------------------------- 解析辅助


def _endpoint(base_url: str, path: str) -> str:
    """拼官方端点；容忍用户在 base_url 末尾带上 ``/v1``。"""
    base = (base_url or "https://api.deepseek.com").strip().rstrip("/")
    if base.endswith("/v1"):
        base = base[:-3].rstrip("/")
    return f"{base}{path}"


def _parse_results(data: dict[str, Any] | None) -> tuple[SearchResult, ...]:
    raw = data.get("results") if isinstance(data, dict) else None
    if not isinstance(raw, list):
        return ()
    results: list[SearchResult] = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        try:
            authority = int(item.get("authority", -1))
        except (TypeError, ValueError):
            authority = -1
        try:
            score = float(item.get("rerank_score", 0.0))
        except (TypeError, ValueError):
            score = 0.0
        results.append(
            SearchResult(
                title=str(item.get("title") or ""),
                url=str(item.get("url") or ""),
                snippet=str(item.get("snippet") or ""),
                summary=str(item.get("summary") or ""),
                content=str(item.get("content") or ""),
                site_name=(
                    str(item["site_name"]) if item.get("site_name") is not None else None
                ),
                date=str(item["date"]) if item.get("date") is not None else None,
                authority=authority,
                rerank_score=score,
            )
        )
    return tuple(results)


def _validate_fetch_url(url: str) -> str | None:
    """Fetch 前置校验（与官方限制一致）；返回错误原因或 None。"""
    if not url:
        return "网页地址不能为空"
    if len(url) > 8192:
        return "网页地址太长（最多 8192 字）"
    try:
        parts = urlsplit(url)
    except ValueError:
        return "网页地址格式不对"
    if parts.scheme not in ("http", "https") or not parts.netloc:
        return "只支持 http/https 网页地址"
    if parts.username or parts.password:
        return "网页地址不能带用户名或密码"
    return None


def _api_error_message(response: httpx.Response) -> str:
    """从 OpenAI 兼容错误体里取 message；取不到返回空串。"""
    try:
        data = response.json()
    except ValueError:
        return ""
    if not isinstance(data, dict):
        return ""
    error = data.get("error")
    if isinstance(error, dict):
        message = error.get("message")
        if isinstance(message, str):
            return message.strip()
    if isinstance(error, str):
        return error.strip()
    return ""
