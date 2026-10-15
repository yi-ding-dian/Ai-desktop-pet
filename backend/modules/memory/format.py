"""记忆上下文注入格式（§4.1：system(画像 + 记忆召回)）。

单一职责：把画像条目与召回记忆渲染成一段 system 文本；
"何时注入 / 注入多少"由 application 层（chat_pipeline）决定。

格式取向：条目紧凑、含义直白；明确告知模型"这是记忆"以避免它向用户
复述（复述记忆会让用户觉得被"监视"，产品体验关键细节）。
"""

from __future__ import annotations

from typing import Sequence

from backend.modules.memory.profile import ProfileItem
from backend.modules.memory.store import Memory

#: 注入块的抬头（对模型说明性质与使用方式）
MEMORY_BLOCK_HEADER = (
    "以下是你对用户的记忆。请自然地运用这些信息（称呼、喜好等），"
    "不要向用户提及“记忆”本身，也不要机械复述。"
)


def build_memory_block(
    profile_items: Sequence[ProfileItem],
    memories: Sequence[Memory],
) -> str | None:
    """组装记忆注入 system 文本；画像与记忆都为空时返回 None（不注入）。"""
    if not profile_items and not memories:
        return None

    lines = [MEMORY_BLOCK_HEADER]
    if profile_items:
        lines.append("")
        lines.append("[用户画像]")
        lines.extend(f"- {item.key}：{item.value}" for item in profile_items)
    if memories:
        lines.append("")
        lines.append("[长期记忆]")
        lines.extend(f"- {memory.text}" for memory in memories)
    return "\n".join(lines)
