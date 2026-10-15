"""modules/voice/splitter.py 单测。

覆盖：跨片段边界（含句号独占一段/收尾符跨片段）、标点组合（连写/省略号）、
弱边界防过碎、换行、小数点保护、flush 残余、纯空白/幂等。
"""

from __future__ import annotations

from backend.modules.voice.splitter import SentenceSplitter


def feed_all(parts: list[str]) -> list[str]:
    """按顺序喂入所有片段，返回累积切出的句子（不含 flush）。"""
    sp = SentenceSplitter()
    out: list[str] = []
    for part in parts:
        out.extend(sp.feed(part))
    return out


def feed_flush(parts: list[str]) -> list[str]:
    """按顺序喂入所有片段后 flush，返回全部句子。"""
    sp = SentenceSplitter()
    out: list[str] = []
    for part in parts:
        out.extend(sp.feed(part))
    out.extend(sp.flush())
    return out


# ---------------------------------------------------------------- 基本切分


def test_single_complete_sentence_after_flush() -> None:
    """句末标点已到但缓冲恰在末尾：非 final 时延迟确认收尾符，flush 时吐出。"""
    sp = SentenceSplitter()
    assert sp.feed("你好呀！") == []
    assert sp.flush() == ["你好呀！"]


def test_multiple_sentences_in_one_chunk() -> None:
    """单片段内含多句：中间句立即切出，最后一句（末尾延迟）随 flush 产出。"""
    assert feed_flush(["你好。今天很好。"]) == ["你好。", "今天很好。"]
    assert feed_all(["你好。今天很好。然后呢"]) == ["你好。", "今天很好。"]


def test_all_strong_punctuations() -> None:
    for text in ("你好。", "你好！", "你好？", "你好；", "你好…"):
        assert feed_flush([text]) == [text], text
    for text in ("Hello.", "Hello!", "Hello?", "Hello;"):
        assert feed_flush([text]) == [text], text
    assert feed_flush(["第一行\n第二行。"]) == ["第一行", "第二行。"]


def test_terminator_runs_absorbed() -> None:
    """连续终止标点（？！ / ！！！ / ……）作为同一句尾吸收。"""
    assert feed_flush(["真的吗？！好的。"]) == ["真的吗？！", "好的。"]
    assert feed_flush(["好！！！知道了。"]) == ["好！！！", "知道了。"]
    assert feed_flush(["嗯……让我想想。"]) == ["嗯……", "让我想想。"]


def test_closing_marks_absorbed_same_chunk() -> None:
    """终止标点后紧跟的收尾符（引号/右括号）随句尾一起切出。"""
    assert feed_flush(["他说：你好。\"然后走了。"]) == ["他说：你好。\"", "然后走了。"]
    assert feed_flush(["喂？）别闹。"]) == ["喂？）", "别闹。"]


# ---------------------------------------------------------------- 跨片段边界


def test_period_at_next_chunk_start() -> None:
    """句号落在下一片段开头：累积后仍正确切句（任务书点名的跨片段场景）。"""
    assert feed_flush(["你好", "。今天呢？"]) == ["你好。", "今天呢？"]


def test_closing_mark_at_next_chunk_start() -> None:
    """收尾符跨片段（句号是本片段末尾、引号在下一片段开头）：吸收后一起切出。"""
    assert feed_flush(["他说：你好。", "\"然后走了。"]) == ["他说：你好。\"", "然后走了。"]


def test_terminator_split_across_chunks() -> None:
    """省略号被切成两个片段：连写吸收后不产生碎片。"""
    assert feed_flush(["嗯…", "…让我想想。"]) == ["嗯……", "让我想想。"]


def test_every_boundary_split_into_chunks() -> None:
    """逐字符喂入（最极端切分）：输出与整块喂入一致。"""
    text = "你好呀！我是小兔。今天过得怎么样？"
    assert feed_flush(list(text)) == feed_flush([text]) == ["你好呀！", "我是小兔。", "今天过得怎么样？"]


def test_feed_empty_chunk_is_noop() -> None:
    sp = SentenceSplitter()
    assert sp.feed("") == []
    assert sp.feed("你好") == []
    assert sp.feed("") == []
    assert sp.flush() == ["你好"]


# ---------------------------------------------------------------- 防过碎（弱边界）


def test_weak_boundary_short_fragment_merged() -> None:
    """逗号处片段过短（<6 字）：不切，与后续合并（防过碎）。"""
    assert feed_flush(["你好，", "我叫小兔。"]) == ["你好，我叫小兔。"]


def test_weak_boundary_long_fragment_cut() -> None:
    """逗号处片段已足够长：提前切出（长句不拖慢 TTS 出声）。"""
    assert feed_flush(["今天天气真不错啊，", "我们出去玩吧。"]) == [
        "今天天气真不错啊，",
        "我们出去玩吧。",
    ]


def test_weak_boundary_accumulates_until_long_enough() -> None:
    """多个短弱片段会累积；在最早满足长度阈值（含标点 ≥6 字）的弱边界切出。"""
    assert feed_flush(["今天，", "天气，", "真不错啊，", "出去走走。"]) == [
        "今天，天气，",
        "真不错啊，出去走走。",
    ]


def test_short_strong_sentence_not_merged() -> None:
    """强边界（终止标点）不受防过碎限制：短句照切。"""
    assert feed_flush(["好。", "我们走吧。"]) == ["好。", "我们走吧。"]


# ---------------------------------------------------------------- 小数点保护


def test_decimal_point_is_not_boundary() -> None:
    assert feed_flush(["圆周率是 3.14 左右。"]) == ["圆周率是 3.14 左右。"]
    assert feed_flush(["版本 2.0 已发布。"]) == ["版本 2.0 已发布。"]


def test_decimal_plus_sentence_end() -> None:
    """小数后的中文句号仍然是句边界。"""
    assert feed_flush(["圆周率约等于 3.14。然后呢"]) == ["圆周率约等于 3.14。", "然后呢"]


# ---------------------------------------------------------------- 空白与残余


def test_flush_tail_without_punctuation() -> None:
    sp = SentenceSplitter()
    assert sp.feed("今天天气不错") == []
    assert sp.flush() == ["今天天气不错"]


def test_whitespace_only_content_dropped() -> None:
    """纯空白片段不产出句子（换行/空行不产生空句）。"""
    assert feed_flush(["  \n  "]) == []
    assert feed_flush(["", "\n\n", "  "]) == []


def test_multiline_reply() -> None:
    assert feed_flush(["第一行。\n", "\n第二行！\n第三行"]) == ["第一行。", "第二行！", "第三行"]


def test_flush_is_idempotent() -> None:
    sp = SentenceSplitter()
    sp.feed("你好。")
    assert sp.flush() == ["你好。"]
    assert sp.flush() == []


def test_strip_around_sentence() -> None:
    """切出的句子去除首尾空白（LLM 常在标点后换行/空格）。"""
    assert feed_flush(["你好。 世界！"]) == ["你好。", "世界！"]
