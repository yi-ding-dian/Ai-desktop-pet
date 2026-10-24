"""提示词组装：system 段落、记忆注入、文件限额与上下文预算。"""

from __future__ import annotations

from datetime import datetime
from typing import TYPE_CHECKING, Callable, Sequence

from loguru import logger

from backend.application.session import Session
from backend.modules.files import FileLimits, FileRef
from backend.modules.llm.prompts import build_system_prompt
from backend.modules.llm.provider import ChatMessage
from backend.modules.memory.format import build_memory_block
from backend.modules.tools import ToolRegistry

if TYPE_CHECKING:  # 仅类型注解；运行时经 Protocol/鸭子类型协作（避免循环 import）
    from backend.application.memory_book_service import MemoryBookService
    from backend.modules.memory.profile import ProfileStore
    from backend.modules.memory.store import MemoryStore
    from backend.shared.config import AppConfig

#: 受“智能搜索”开关控制的工具名（其余工具不受影响）
SEARCH_TOOL_NAMES = frozenset({"web_search", "web_fetch"})


def tool_gist(description: str) -> str:
    """工具描述压成一行（取第一句，超长再截断）：system 里的清单只留“何时用”。"""
    text = " ".join((description or "").split())
    for index, char in enumerate(text):
        if char in "。！？":
            return text[: index + 1]
    return text if len(text) <= 80 else f"{text[:80]}…"


#: 教学模式（黑板）的临时 system 提示：讲课/讲文档场景的结构化输出要求
TEACHING_HINT = (
    "当前处于教学模式（黑板讲解）：请以老师口吻授课。先用 Markdown 二级标题给出讲解大纲，"
    "再按章节逐段展开；重点用列表、表格、代码块呈现，讲清“是什么、为什么、怎么用”。"
    "用户插问时先直接回答，再自然回到讲解主线；不要提及教学模式或提示词本身。"
)


#: 句子是否"可发音"（含字母/数字/汉字才值得合成）——纯标点、空白、emoji 跳过
def is_speakable(text: str) -> bool:
    return any(ch.isalnum() for ch in text)


def stored_user_text(user_text: str, refs: Sequence[FileRef]) -> str:
    """历史/落库用的脱敏用户消息：``📎 文件名`` + 问题，不含文件正文与绝对路径。"""
    names = "、".join(ref.display_name for ref in refs)
    label = f"📎 {names}"
    text = user_text.strip()
    return f"{label}\n{text}" if text else label


def insert_system_hints(
    messages: list[ChatMessage], hints: Sequence[str]
) -> list[ChatMessage]:
    """把临时 system 提示插在开头 system 段之后、历史/本轮用户消息之前。

    部分网关对"system 出现在 user 之后"很敏感，不能直接 append。
    """
    if not hints:
        return messages
    hint_messages = [ChatMessage(role="system", content=text) for text in hints]
    first_non_system = next(
        (i for i, item in enumerate(messages) if item.role != "system"),
        len(messages),
    )
    return [*messages[:first_non_system], *hint_messages, *messages[first_non_system:]]


class PromptBuilder:
    """按当前装配（画像 / 记忆 / 记忆本 / 工具 / 配置）组装每轮 messages。"""

    def __init__(
        self,
        *,
        memories: MemoryStore | None = None,
        profile: ProfileStore | None = None,
        pet_name: Callable[[], str | None] | None = None,
        memory_book: MemoryBookService | None = None,
        tools: ToolRegistry | None = None,
        config: Callable[[], AppConfig] | None = None,
    ) -> None:
        self._memories = memories
        self._profile = profile
        self._pet_name = pet_name
        self._memory_book = memory_book
        self._tools = tools
        self._config = config

    def tool_lines(self, *, search: bool = True) -> list[str]:
        """按**实际注册表**生成 system 里的工具清单（- 名字：何时用）。

        - 未装配注册表（单测/旧装配）返回空列表，不编造工具；
        - ``search=False``（本轮关闭智能搜索）时剔除联网工具，清单与真实可用工具一致。
        """
        if self._tools is None:
            return []
        lines: list[str] = []
        for spec in self._tools.all():
            if not search and spec.name in SEARCH_TOOL_NAMES:
                continue
            lines.append(f"- {spec.name}：{tool_gist(spec.description)}")
        return lines

    async def build_messages(
        self, session: Session, *, user_text: str, search: bool = True
    ) -> list[ChatMessage]:
        """组装本轮请求 messages（§4.1/§4.2）：

            system(人格 + [名字注入] + 情绪指令)
              → system(画像 + 记忆召回)   ← P3：有内容才注入
              → 最近 N 轮原文（含本轮用户输入）
        """
        pet_name = self._pet_name() if self._pet_name is not None else None
        messages = [
            ChatMessage(
                role="system",
                content=build_system_prompt(
                    pet_name=pet_name, tool_lines=self.tool_lines(search=search)
                ),
            )
        ]
        memory_block = await self.build_memory_block(user_text)
        if memory_block is not None:
            messages.append(ChatMessage(role="system", content=memory_block))
        memory_book_block = self.build_memory_book_block()
        if memory_book_block is not None:
            messages.append(ChatMessage(role="system", content=memory_book_block))
        time_block = self.time_block()
        if time_block is not None:
            messages.append(ChatMessage(role="system", content=time_block))
        messages.extend(session.recent_messages())
        return messages

    async def build_memory_block(self, query: str) -> str | None:
        """画像 + 记忆召回 → 第二条 system 文本；无内容/未装配返回 None。"""
        if self._memories is None and self._profile is None:
            return None

        profile_items = []
        if self._profile is not None:
            try:
                profile_items = self._profile.all()
            except Exception:
                logger.exception("画像读取失败（本轮跳过画像注入）")

        memories = []
        if self._memories is not None:
            try:
                memories = await self._memories.recall(query)
            except Exception:
                logger.exception("记忆召回失败（本轮跳过记忆注入）")

        block = build_memory_block(profile_items, memories)
        if block is None:
            logger.debug("记忆注入：无画像与记忆，跳过")
            return None

        logger.info("记忆注入：画像 {} 条 / 长期记忆 {} 条", len(profile_items), len(memories))
        if memories and self._memories is not None:
            try:
                self._memories.mark_used([memory.id for memory in memories])
            except Exception:
                logger.exception("记忆 last_used_at 更新失败（不影响本轮对话）")
        return block

    def build_memory_book_block(self) -> str | None:
        """记忆本清单 → 第三条 system 文本；未装配/为空返回 None。"""
        if self._memory_book is None:
            return None
        try:
            block = self._memory_book.build_prompt_block()
        except Exception:
            logger.exception("记忆本注入失败（本轮跳过）")
            return None
        if block is None:
            logger.debug("记忆本注入：无条目，跳过")
            return None
        try:
            logger.info("记忆本注入：{} 条", self._memory_book.count())
        except Exception:
            pass
        return block

    def compose_messages(
        self,
        memory_block: str | None,
        history: Sequence[ChatMessage],
        current_content: str,
        *,
        images: Sequence[str] = (),
        search: bool = True,
    ) -> list[ChatMessage]:
        """文件轮的消息组装：system(人格) + [system(记忆)] + 历史 + 本轮（文本 + 图片）。"""
        pet_name = self._pet_name() if self._pet_name is not None else None
        messages = [
            ChatMessage(
                role="system",
                content=build_system_prompt(
                    pet_name=pet_name, tool_lines=self.tool_lines(search=search)
                ),
            )
        ]
        if memory_block is not None:
            messages.append(ChatMessage(role="system", content=memory_block))
        memory_book_block = self.build_memory_book_block()
        if memory_book_block is not None:
            messages.append(ChatMessage(role="system", content=memory_book_block))
        time_block = self.time_block()
        if time_block is not None:
            messages.append(ChatMessage(role="system", content=time_block))
        messages.extend(history)
        messages.append(
            ChatMessage(role="user", content=current_content, images=tuple(images))
        )
        return messages

    def file_limits(self) -> FileLimits:
        """当前文件限额（热配置；未装配配置的测试场景用 FileLimits 默认值）。"""
        config = self._config() if self._config is not None else None
        if config is None:
            return FileLimits()
        return FileLimits(
            max_chars=config.files.max_chars,
            max_bytes=config.files.max_bytes,
            max_per_turn=config.files.max_per_turn,
            max_image_bytes=config.files.max_image_bytes,
            allow_images=config.files.allow_images,
        )

    def time_block(self) -> str | None:
        """当前本地时间注入（仅在装配了提醒工具时）。"""
        if self._tools is None or self._tools.get("create_reminder") is None:
            return None
        now = datetime.now().astimezone()
        weekdays = "一二三四五六日"
        offset = now.strftime("%z")
        tz_text = f"UTC{offset[:3]}:{offset[3:]}" if offset else "本地时区"
        return (
            f"当前本地时间：{now:%Y-%m-%d %H:%M}（周{weekdays[now.weekday()]}，{tz_text}）。"
            "用户说相对时间（如“20 分钟后”“明天早上”）时，请基于这个时间换算成绝对时间；"
            "调用提醒工具时 due_at 必须是带时区偏移的 ISO 时间。"
        )

    def context_budget(self) -> int:
        """本轮可用输入 token 预算 = 上下文预算 - 输出预留 - 安全余量。"""
        config = self._config() if self._config is not None else None
        context = config.llm.context_tokens if config is not None else 100_000
        output = config.llm.max_tokens if config is not None else 768
        return max(1_000, context - output - 512)
