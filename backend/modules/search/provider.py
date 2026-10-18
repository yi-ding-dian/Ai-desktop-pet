"""搜索 provider 抽象（2026-10-18：DeepSeek Search / Fetch）。

本域只定义契约与数据类型；实现见 ``deepseek.py``。application 层的
``SearchService`` 负责把结果格式化成工具回传内容，并区分"给用户看的通知"
与"给模型读的 model_content"。
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol


@dataclass(frozen=True)
class SearchResult:
    """一条搜索结果（字段与 DeepSeek Search 响应对齐，缺失值已归一）。"""

    title: str
    url: str
    snippet: str = ""
    summary: str = ""
    content: str = ""
    site_name: str | None = None
    date: str | None = None
    authority: int = -1
    rerank_score: float = 0.0


@dataclass(frozen=True)
class SearchOutcome:
    """搜索调用结果；``ok=False`` 时 message 是可直接给用户看的原因。"""

    ok: bool
    code: str
    message: str
    results: tuple[SearchResult, ...] = ()


@dataclass(frozen=True)
class FetchOutcome:
    """网页抓取结果；``content`` 为 Markdown 正文（已按配置截断）。"""

    ok: bool
    code: str
    message: str
    title: str = ""
    content: str = ""
    truncated: bool = False


class SearchProvider(Protocol):
    """搜索服务抽象（DeepSeek 实现 / 测试替身）。"""

    async def search(
        self,
        query: str,
        *,
        count: int,
        ori_question: str | None = None,
        need_content: bool = False,
    ) -> SearchOutcome:
        """搜索网页，返回结构化结果。"""
        ...

    async def fetch(self, url: str, *, max_chars: int) -> FetchOutcome:
        """抓取单个网页，返回 Markdown 正文（截断到 max_chars）。"""
        ...
