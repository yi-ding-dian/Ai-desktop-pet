"""联网搜索工具（2026-10-18）：web_search / web_fetch（backend + feedback）。"""

from __future__ import annotations

from typing import Any

from backend.modules.tools.registry import ToolRegistry, ToolSpec


def register_search_tools(registry: ToolRegistry, search: Any) -> None:
    """注册联网搜索工具（服务接口见 application/search_service.py）。

    结果通过 ``feedback=True`` 回喂给模型：chat 管道先执行工具，再把搜索结果
    作为 tool 消息追加到上下文，跑第二轮 LLM 生成最终回答。
    """

    async def web_search(args: dict[str, Any], user_text: str) -> dict[str, Any]:
        return await search.search_from_tool(args, user_text)

    async def web_fetch(args: dict[str, Any]) -> dict[str, Any]:
        return await search.fetch_from_tool(args)

    registry.register(
        ToolSpec(
            name="web_search",
            description=(
                "联网搜索实时网页（DeepSeek Search）。用户问最新/今天/最近/实时/"
                "新闻/价格/天气/版本发布等当前信息，或明确说“搜一下/查一下/搜索”时调用。"
                "query 用简洁关键词（1–128 字，支持 site: / -site: / \"精确短语\" / "
                "after: / before: 等语法）；不要搜索用户隐私或本地文件内容。"
                "搜索结果会返回给你阅读；回答时用 [1][2] 标注来源，并在末尾列出"
                "用到的标题与 URL。结果条数由用户设置决定，不要自己指定。"
            ),
            parameters={
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "搜索关键词（1–128 字）",
                    }
                },
                "required": ["query"],
            },
            executor="backend",
            handler=web_search,
            needs_user_text=True,
            feedback=True,
            ack="我搜一下～",
        )
    )
    registry.register(
        ToolSpec(
            name="web_fetch",
            description=(
                "抓取一个 http/https 网页并读取 Markdown 正文（DeepSeek Fetch）。"
                "用户给出具体链接并让你看看/总结/读一下，或搜索结果里的页面需要"
                "细读时调用。不要抓取需要登录、明显私密或本机/内网的地址。"
                "抓到的正文会返回给你阅读；回答时注明本页标题与 URL。"
            ),
            parameters={
                "type": "object",
                "properties": {
                    "url": {
                        "type": "string",
                        "description": "要读取的网页地址（http/https）",
                    }
                },
                "required": ["url"],
            },
            executor="backend",
            handler=web_fetch,
            feedback=True,
            ack="我看看这个网页～",
        )
    )
