"""流式分句器（设计文档 §4.4 语音流水线：sentence 事件 → TTS）。

LLM 输出是**任意切分**的流式片段，本分句器把片段流转换为"可确定的完整句子"，
供 TTS 按句合成（一句话一帧，见 §3.5 二进制帧格式）。

句边界规则（v1）：
- 强边界（遇即切，无论长短）：中文 ``。！？；…``、英文 ``.!?;``、换行 ``\\n``；
- 弱边界（仅当切出片段够长才切，避免超长句拖慢 TTS 出声）：
  逗号 ``，,``、顿号 ``、``、冒号 ``：:``；
- 防过碎：弱边界处切出的片段 strip 后短于 ``MIN_SENTENCE_LEN`` 时**不切**，
  与后续内容合并累积（强边界不受此限——终止标点已明确句尾）；
- 收尾符吸收：终止标点后紧跟的引号/右括号/书名号右半（如 ``你好。"``）
  跟随句尾一起切出，不在下一句开头遗留孤立引号；
  收尾符可能落在下一片段开头（跨片段），此时延迟一个片段确认；
- 小数点保护：英文 ``.`` 前一字符是数字时（如 ``3.14``）不视为句边界。

已知简化（v1 有意不做，见 report）：英文缩写（``Mr.`` / ``e.g.`` / ``U.S.``）
不区分；跨片段收尾符之外的 lookahead 不做。
"""

from __future__ import annotations

# 强边界：中文终止标点 + 英文终止标点 + 换行
_STRONG: frozenset[str] = frozenset("。！？；…" + ".!?;" + "\n")
# 弱边界：长句提前断点（逗号 / 顿号 / 冒号），仅在片段足够长时启用
_WEAK: frozenset[str] = frozenset("，,、：:")
# 收尾符：紧跟终止标点后应随句尾一起切出（右引号 / 右括号 / 书名号右半等）
_CLOSING: frozenset[str] = frozenset("\"'”’）)]}」』】》〉")
# 切点后允许连续吸收的字符（连续标点如 `？！`、`……`、`。。。` 一并带走）
_ABSORB: frozenset[str] = _STRONG | _CLOSING


class SentenceSplitter:
    """把任意切分的流式文本片段，累积为完整句子输出（feed / flush 模式）。

    用法与 EmotionTagParser 对称::

        sp = SentenceSplitter()
        sp.feed("你好")      # -> []
        sp.feed("。今天呢")   # -> ["你好。"]
        sp.flush()           # -> ["今天呢"]（流结束吐出残余）
    """

    #: 弱边界最短片段长度（含标点，strip 后）；短于此值的弱切点被忽略
    MIN_SENTENCE_LEN = 6

    def __init__(self) -> None:
        self._buf = ""  # 尚未切出的累积文本
        self._cut: int | None = None  # 已确认的切点位置（等待吸收收尾符确认）

    def feed(self, chunk: str) -> list[str]:
        """喂入一个流式片段；返回本次可确定切出的完整句列表（可能为空）。"""
        if chunk:
            self._buf += chunk
        return self._drain(final=False)

    def flush(self) -> list[str]:
        """流结束：切出全部剩余内容（残余无标点文本整体作为最后一句）。"""
        out = self._drain(final=True)
        rest = self._buf.strip()
        if rest:
            out.append(rest)
        self._buf = ""
        self._cut = None
        return out

    # ---------- 内部实现 ----------

    def _drain(self, *, final: bool) -> list[str]:
        """循环找出可确定的切点并切句。

        ``_cut`` 已确认却因缓冲到末尾而无法判定吸收范围时（收尾符可能落在
        下一片段开头），非 final 场景延迟等待；final（flush）时强制收口。
        """
        out: list[str] = []
        while True:
            if self._cut is None:
                cut = self._first_cut(self._buf)
                if cut is None:
                    break
                self._cut = cut

            end = self._absorb(self._cut)
            if end >= len(self._buf) and not final:
                self._cut = end  # 缓冲到末尾：等后续片段确认是否继续吸收
                break

            sentence = self._buf[:end].strip()
            if sentence:
                out.append(sentence)
            self._buf = self._buf[end:]
            self._cut = None
        return out

    @staticmethod
    def _first_cut(buf: str) -> int | None:
        """返回第一个切点位置（切点字符之后的下标）；无切点返回 None。"""
        for i, ch in enumerate(buf):
            if ch in _STRONG:
                if ch == "." and i > 0 and buf[i - 1].isdigit():
                    continue  # 小数点（3.14 / 2.0）不是句边界
                return i + 1
            if ch in _WEAK and len(buf[: i + 1].strip()) >= SentenceSplitter.MIN_SENTENCE_LEN:
                return i + 1  # 弱边界：仅当片段已足够长（防过碎）
        return None

    def _absorb(self, pos: int) -> int:
        """从 pos 起吸收连续的可吸收字符（终止标点连写 / 收尾符）。"""
        while pos < len(self._buf) and self._buf[pos] in _ABSORB:
            pos += 1
        return pos
