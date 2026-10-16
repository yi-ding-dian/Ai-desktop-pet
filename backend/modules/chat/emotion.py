"""流式情绪标签解析器（设计文档 §4.2）。

LLM 流式输出的文本里可能随时出现 ``<emo:xxx>`` 标签，且标签可能被切分到
多个流式片段（例如 ``"<emo:ha"`` + ``"ppy>"``，甚至跨三个片段）。
本解析器用累积缓冲保证：

1. 绝不向下游吐出半个标签；
2. 标签剥离后，按出现顺序返回「文本片段 / 情绪事件」序列（顺序保真）；
3. 流结束时若残留未闭合的半标签，按普通文本原样吐出（§4.2）。

解析器是纯机制（不校验情绪白名单）：剥离所有形如 ``<emo:[a-z_]+>`` 的标签，
取值合法性（v1 固定集合）由上层 chat_pipeline 过滤。

宽容剥离（2026-10-16）：模型（deepseek-flash 实测）偶发把标签写成 HTML 风格
（``</emo>`` / ``<emo>`` / ``<emo/>``——约定是 ``<emo:name>``，漏了冒号与情绪名）。
这类变体**就地剥离但不产生情绪事件**——只吞标签、不解析（防标签字面漏给用户，
实报"……还是随便聊聊？</emo>我随时待命……"）。
"""

from __future__ import annotations

import re
from dataclasses import dataclass

# v1 固定情绪集合（设计文档 §3.3）
EMOTION_VALUES: frozenset[str] = frozenset(
    {"neutral", "happy", "sad", "angry", "surprised", "shy", "thinking", "sleepy"}
)

_EMO_OPEN = "<emo:"
_EMO_TAG_RE = re.compile(r"<emo:([a-z_]+)>")
_EMO_TAIL_RE = re.compile(r"[a-z_]*")

# 宽容剥离（2026-10-16）：模型（deepseek-flash 实测）偶发把情绪标签写成 HTML 风格——
# `</emo>` / `<emo>` / `<emo/>` 等（约定是 <emo:name>，漏了冒号与情绪名）。变体无情绪名
# 可解析，**就地剥离、不产生 EmotionPart**（否则标签文字原样漏给用户：实报"聊聊？</emo>我…"）。
_EMO_LOOSE_RE = re.compile(r"</?emo\s*/?>", re.IGNORECASE)
# 宽容形式的"完整尾部"全集（供流式前缀判定：半个变体标签也要等补齐，不能提前当文本吐出；
# 带空格变体一并列出——判定时先 rstrip 尾空格，这里覆盖"空格 + 斜杠"组合）
_LOOSE_TAILS = ("/emo>", "/emo/>", "/emo >", "/emo />", "emo>", "emo/>", "emo >", "emo />")


@dataclass(frozen=True)
class TextPart:
    """干净文本片段（已剥离情绪标签）。"""

    text: str


@dataclass(frozen=True)
class EmotionPart:
    """解析出的情绪事件。"""

    emotion: str


Part = TextPart | EmotionPart


class EmotionTagParser:
    """把任意切分的流式文本片段，转换为有序的解析结果列表。"""

    def __init__(self) -> None:
        self._buf = ""

    def feed(self, chunk: str) -> list[Part]:
        """喂入一个流式片段；返回本次可确定输出的部分（可能为空列表）。"""
        if chunk:
            self._buf += chunk
        return self._drain()

    def flush(self) -> list[Part]:
        """流结束：把残留的未闭合半标签按普通文本吐出。"""
        parts = self._drain()
        if self._buf:
            parts.append(TextPart(self._buf))
            self._buf = ""
        return parts

    # ---------- 内部实现 ----------

    def _drain(self) -> list[Part]:
        """扫描缓冲，输出一切可以确定的内容，半标签留在缓冲里等待补齐。"""
        parts: list[Part] = []
        while self._buf:
            lt = self._buf.find("<")
            if lt == -1:
                # 没有标签起点：全部是普通文本
                parts.append(TextPart(self._buf))
                self._buf = ""
                break
            if lt > 0:
                # 标签前的普通文本先输出，缓冲对齐到 '<' 开头
                parts.append(TextPart(self._buf[:lt]))
                self._buf = self._buf[lt:]

            match = _EMO_TAG_RE.match(self._buf)
            if match:
                parts.append(EmotionPart(match.group(1)))
                self._buf = self._buf[match.end():]
                continue

            loose = _EMO_LOOSE_RE.match(self._buf)
            if loose:
                # 宽容剥离：HTML 风格变体（</emo>、<emo>、<emo/>……）——模型偶发不按
                # <emo:name> 约定输出；无情绪名，不产生 EmotionPart（见文件头 _EMO_LOOSE_RE）
                self._buf = self._buf[loose.end():]
                continue

            if _is_possible_tag_prefix(self._buf):
                break  # 可能是半个标签，等后续片段补齐

            # 不是情绪标签（如 "1 < 2"、"<emotion>"）：'<' 按普通文本吐出
            parts.append(TextPart("<"))
            self._buf = self._buf[1:]
        return parts


def _is_possible_tag_prefix(s: str) -> bool:
    """判断以 '<' 开头的 s，是否可能是某个"可剥标签"（``<emo:name>`` 或宽容变体）的前缀。

    流式安全关键：可能的半标签要留在缓冲等后续片段补齐，不能提前当普通文本吐出——
    宽容变体同理（如 "</em" + "o>"），否则半个标签会被当文本漏出。
    """
    # ① 标准 <emo:name> 前缀（原逻辑："<emo:" 本身或其后跟未闭合的名字部分）
    if len(s) <= len(_EMO_OPEN):
        if _EMO_OPEN.startswith(s):
            return True
    else:
        tail = s[len(_EMO_OPEN):]
        if ">" not in tail and _EMO_TAIL_RE.fullmatch(tail) is not None:
            return True
    # ② 宽容变体（</emo> / <emo> / <emo/> 等）：s[1:] 是否为某个变体尾部的前缀
    t = s[1:].lower().rstrip()  # rstrip：分片可能切在尾部空格处（"</emo " + ">"）
    if not t:
        return True  # 仅 '<'（或 < 加空格）：还得等下一个字符才能判断
    return any(tail.startswith(t) for tail in _LOOSE_TAILS)
