"""搜索域（2026-10-18）：DeepSeek Search / Fetch 的 provider 与结果格式化。

- ``provider``：SearchProvider 抽象 + SearchResult/SearchOutcome/FetchOutcome；
- ``deepseek``：官方 ``/v1/tools/search`` / ``/v1/tools/fetch`` 实现；
- ``format``：给模型读的编号资料（含"网页内容不可信"提示）。

计费提醒：Search / Fetch 各 ¥5 / 1000 次成功请求；2026-11-01 00:00（北京时间）
起计费；由 ``[search].enabled`` 开关控制是否启用。
"""

from backend.modules.search.deepseek import DeepSeekSearchProvider
from backend.modules.search.format import (
    format_fetch_error_for_model,
    format_fetch_for_model,
    format_search_empty_for_model,
    format_search_error_for_model,
    format_search_for_model,
)
from backend.modules.search.provider import (
    FetchOutcome,
    SearchOutcome,
    SearchProvider,
    SearchResult,
)

__all__ = [
    "DeepSeekSearchProvider",
    "FetchOutcome",
    "SearchOutcome",
    "SearchProvider",
    "SearchResult",
    "format_fetch_error_for_model",
    "format_fetch_for_model",
    "format_search_empty_for_model",
    "format_search_error_for_model",
    "format_search_for_model",
]
