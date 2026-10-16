"""内置指令词表（快通道，§4.7）：用户输入 → 工具名的确定性匹配。

为什么需要快通道：模型调用工具存在不确定性（可能只给文字步骤而不实际调用、
或在网关不支持 tools 时完全失效）；对"打开设置"这类高频、意图明确的指令，
用本地词表直接命中、绕过模型，保证必达。

词表从迁移前的前端实现平移（原 frontend/src/modules/teaching/index.ts 的
SETTINGS_KEYWORDS ``/打开设置|设置面板/``，已由前端侧回收）：**包含匹配**
（re.search，与前端行为一致——"帮我打开设置面板"也要命中）。

结构上是"正则 → 工具名"的有序表：将来加指令（如"打开黑板"）在
``_DIRECTIVES`` 追加一行即可；命中即返回（先到先得）。
"""

from __future__ import annotations

import re

#: 指令词表：每项为 (匹配正则, 目标工具名)。顺序即优先级。
_DIRECTIVES: tuple[tuple[re.Pattern[str], str], ...] = (
    (re.compile(r"打开设置|设置面板"), "open_settings"),
)


def match_directive(text: str) -> str | None:
    """在用户输入中匹配内置指令词表；命中返回工具名，未命中返回 None。

    包含匹配（与迁移前前端正则行为一致）；不做分词 / 不区分大小写需求
    （当前词表全中文）。
    """
    for pattern, tool_name in _DIRECTIVES:
        if pattern.search(text):
            return tool_name
    return None
