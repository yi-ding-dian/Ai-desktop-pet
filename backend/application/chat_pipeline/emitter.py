"""出站事件收口：文本/情绪推送与一次性提示。"""

from __future__ import annotations

from typing import Awaitable, Callable

from loguru import logger

from backend.application.chat_pipeline.types import ReplySink
from backend.modules.chat.emotion import EMOTION_VALUES, EmotionPart, Part, TextPart


async def send_notice(
    sink: ReplySink, code: str, message: str, level: str = "info"
) -> None:
    """发一次性提示；旧 sink / 测试替身没有 notice 时静默跳过（不阻断对话）。"""
    notice = getattr(sink, "notice", None)
    if notice is None:
        return
    try:
        await notice(code, message, level)
    except Exception:  # 提示是旁路信息，失败不应影响本轮
        logger.debug("notice 发送失败（忽略）：code={}", code)


async def emit_parts(
    sink: ReplySink,
    message_id: str,
    parts: list[Part],
    clean_parts: list[str],
    *,
    on_clean_text: Callable[[str], Awaitable[None]] | None = None,
) -> str | None:
    """按顺序推送解析结果（顺序保真）：文本 → token，情绪 → emotion。

    ``on_clean_text``：干净文本的旁路回调（语音链路喂分句器用），
    不改变 token 事件的推送顺序与内容。

    返回本批**最后一个**合法情绪名（无情绪时为 None）——供调用方
    跟踪"本轮最后情绪"并随 assistant 消息落库（§6.2 messages.emotion）。
    """
    last_emotion: str | None = None
    for part in parts:
        if isinstance(part, TextPart):
            clean_parts.append(part.text)
            await sink.token(message_id, part.text)
            if on_clean_text is not None:
                await on_clean_text(part.text)
        elif isinstance(part, EmotionPart):
            if part.emotion in EMOTION_VALUES:
                last_emotion = part.emotion
                await sink.emotion(message_id, part.emotion, 1.0)
            else:
                # 白名单外的标签已剥离，不向前端推送未知情绪
                logger.warning("忽略 v1 情绪集合外的标签：<emo:{}>", part.emotion)
    return last_emotion
