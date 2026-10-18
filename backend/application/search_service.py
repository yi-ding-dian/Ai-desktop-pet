"""联网搜索用例编排（2026-10-18，application 层）。

工具 ``web_search`` / ``web_fetch`` 的 handler 在这里：
- 检查开关（设置 → 搜索；默认关闭）；
- 调 provider，把结果分成两份：
  - ``message``：给用户的确定性通知（"已联网搜索：5 条结果"）；
  - ``model_content``：给模型读的编号资料（搜索结果 / 网页正文 / 失败说明）；
- chat 流水线看到 ``model_content`` 后会做一次"工具结果回传"的第二轮 LLM 调用，
  让模型基于真实网页内容回答（见 application/chat_pipeline.py）。

本服务不删除、不打开任何东西；只发起只读的 Search / Fetch 请求。
"""

from __future__ import annotations

from typing import Any, Callable

from backend.modules.search.format import (
    format_fetch_error_for_model,
    format_fetch_for_model,
    format_search_empty_for_model,
    format_search_error_for_model,
    format_search_for_model,
)
from backend.modules.search.provider import SearchProvider
from backend.shared.config import SearchConfig


def _string(args: dict[str, Any], key: str) -> str:
    value = args.get(key)
    return value.strip() if isinstance(value, str) else ""


def _disabled_result() -> dict[str, Any]:
    return {
        "ok": False,
        "code": "search_disabled",
        "message": "联网搜索还没开，去设置 → 搜索里打开开关～",
        "model_content": (
            "[联网搜索未开启] 请告诉用户去“设置 → 搜索”打开「联网搜索」开关；"
            "这次不要编造搜索结果。"
        ),
    }


class SearchService:
    """搜索工具用例：开关检查 + provider 调用 + 模型资料格式化。"""

    def __init__(
        self,
        provider: SearchProvider,
        *,
        config: Callable[[], SearchConfig],
    ) -> None:
        self._provider = provider
        self._config = config

    async def search_from_tool(
        self, args: dict[str, Any], user_text: str = ""
    ) -> dict[str, Any]:
        cfg = self._config()
        if not cfg.enabled:
            return _disabled_result()

        query = _string(args, "query")
        if not query:
            return {
                "ok": False,
                "code": "search_bad_query",
                "message": "要搜索什么？给我一个关键词就行～",
                "model_content": (
                    "[联网搜索失败] 没有提供搜索词。请先问用户想搜什么，不要编造结果。"
                ),
            }
        # 结果条数以“设置 → 搜索 → 每次结果数”为唯一口径：模型不传 count，
        # 避免模型按 API 默认值（10）盖过用户设置。
        count = max(1, min(50, int(cfg.count)))

        outcome = await self._provider.search(
            query,
            count=count,
            ori_question=user_text or None,
            need_content=cfg.need_content,
        )
        if not outcome.ok:
            return {
                "ok": False,
                "code": outcome.code,
                "message": outcome.message,
                "model_content": format_search_error_for_model(outcome.message),
            }
        if not outcome.results:
            return {
                "ok": True,
                "code": outcome.code,
                "message": "没有找到相关结果",
                "model_content": format_search_empty_for_model(query),
            }
        return {
            "ok": True,
            "code": "search_ok",
            "message": f"已联网搜索：{len(outcome.results)} 条结果",
            "model_content": format_search_for_model(
                query, outcome.results, original_question=user_text or None
            ),
        }

    async def fetch_from_tool(self, args: dict[str, Any]) -> dict[str, Any]:
        cfg = self._config()
        if not cfg.enabled:
            return _disabled_result()

        url = _string(args, "url")
        if not url:
            return {
                "ok": False,
                "code": "fetch_bad_url",
                "message": "要读取哪个网页？给我一个 http/https 链接～",
                "model_content": (
                    "[网页抓取失败] 没有提供网址。请先问用户要读取哪个链接，不要编造内容。"
                ),
            }

        outcome = await self._provider.fetch(url, max_chars=cfg.max_fetch_chars)
        if not outcome.ok:
            return {
                "ok": False,
                "code": outcome.code,
                "message": outcome.message,
                "model_content": format_fetch_error_for_model(outcome.message),
            }
        title = (outcome.title or url).strip()
        return {
            "ok": True,
            "code": "fetch_ok",
            "message": f"已抓取网页：{title[:60]}",
            "model_content": format_fetch_for_model(
                title=outcome.title,
                url=url,
                content=outcome.content,
                truncated=outcome.truncated,
            ),
        }
