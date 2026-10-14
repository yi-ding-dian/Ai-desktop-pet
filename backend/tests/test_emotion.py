"""modules/chat/emotion.py 单测：覆盖流式切分的全部边界用例。

对应设计文档 §10 风险 #5「流式情绪标签解析边界 bug（半标签）」的验收测试。
"""

from __future__ import annotations

from backend.modules.chat.emotion import EmotionPart, EmotionTagParser, Part, TextPart


def parse_all(chunks: list[str]) -> list[Part]:
    """按给定片段顺序喂入解析器，返回完整结果（含 flush）。"""
    parser = EmotionTagParser()
    parts: list[Part] = []
    for chunk in chunks:
        parts.extend(parser.feed(chunk))
    parts.extend(parser.flush())
    return parts


def joined_text(parts: list[Part]) -> str:
    return "".join(p.text for p in parts if isinstance(p, TextPart))


def emotions(parts: list[Part]) -> list[str]:
    return [p.emotion for p in parts if isinstance(p, EmotionPart)]


# ---------------------------------------------------------------- 基本位置


def test_tag_alone() -> None:
    assert parse_all(["<emo:happy>"]) == [EmotionPart("happy")]


def test_tag_at_chunk_start() -> None:
    assert parse_all(["<emo:happy>你好"]) == [EmotionPart("happy"), TextPart("你好")]


def test_tag_at_chunk_end() -> None:
    assert parse_all(["你好<emo:happy>"]) == [TextPart("你好"), EmotionPart("happy")]


def test_tag_in_chunk_middle() -> None:
    assert parse_all(["你好<emo:happy>世界"]) == [
        TextPart("你好"),
        EmotionPart("happy"),
        TextPart("世界"),
    ]


def test_tag_occupies_whole_chunk() -> None:
    assert parse_all(["你好", "<emo:happy>", "世界"]) == [
        TextPart("你好"),
        EmotionPart("happy"),
        TextPart("世界"),
    ]


# ---------------------------------------------------------------- 跨片段切分


def test_tag_split_across_two_chunks() -> None:
    assert parse_all(["<emo:ha", "ppy>"]) == [EmotionPart("happy")]


def test_tag_split_across_three_chunks() -> None:
    assert parse_all(["<emo", ":ha", "ppy>"]) == [EmotionPart("happy")]


def test_tag_split_with_leading_text() -> None:
    assert parse_all(["你好<emo:ha", "ppy>世界"]) == [
        TextPart("你好"),
        EmotionPart("happy"),
        TextPart("世界"),
    ]


def test_tag_split_right_after_lt() -> None:
    assert parse_all(["<", "emo:happy>"]) == [EmotionPart("happy")]


def test_multiple_tags_cross_chunks_with_text() -> None:
    parts = parse_all(["<emo:ha", "ppy>中间<emo:th", "inking>尾"])
    assert parts == [
        EmotionPart("happy"),
        TextPart("中间"),
        EmotionPart("thinking"),
        TextPart("尾"),
    ]


def test_char_by_char_feed() -> None:
    text = "你好<emo:happy>世界<emo:sad>!"
    parts = parse_all(list(text))
    assert parts == [
        TextPart("你"),
        TextPart("好"),
        EmotionPart("happy"),
        TextPart("世"),
        TextPart("界"),
        EmotionPart("sad"),
        TextPart("!"),
    ]


# ---------------------------------------------------------------- 连续标签


def test_consecutive_tags_single_chunk() -> None:
    assert parse_all(["<emo:happy><emo:sad>"]) == [EmotionPart("happy"), EmotionPart("sad")]


def test_consecutive_tags_across_chunks() -> None:
    assert parse_all(["<emo:happy><emo", ":sad>"]) == [
        EmotionPart("happy"),
        EmotionPart("sad"),
    ]


def test_tags_around_text_order_fidelity() -> None:
    parts = parse_all(["A<emo:happy>B<emo:sad>C"])
    assert parts == [
        TextPart("A"),
        EmotionPart("happy"),
        TextPart("B"),
        EmotionPart("sad"),
        TextPart("C"),
    ]


# ---------------------------------------------------------------- 未闭合 / 半标签


def test_unclosed_tag_flushed_as_text() -> None:
    parts = parse_all(["你好<emo:ha"])
    assert emotions(parts) == []
    assert joined_text(parts) == "你好<emo:ha"


def test_lone_lt_flushed_as_text() -> None:
    parts = parse_all(["好<"])
    assert emotions(parts) == []
    assert joined_text(parts) == "好<"


def test_partial_tag_then_normal_text_not_swallowed() -> None:
    # 半标签后面来了非标签字符：不再等待，按普通文本原样吐出
    parts = parse_all(["<emo:happy", "今天"])
    assert emotions(parts) == []
    assert joined_text(parts) == "<emo:happy今天"


def test_unclosed_tag_after_completed_tag() -> None:
    parts = parse_all(["<emo:happy>尾巴<emo:th"])
    assert emotions(parts) == ["happy"]
    assert joined_text(parts) == "尾巴<emo:th"


# ---------------------------------------------------------------- 非标签文本（不应误吞）


def test_plain_lt_text() -> None:
    parts = parse_all(["1 < 2"])
    assert emotions(parts) == []
    assert joined_text(parts) == "1 < 2"


def test_html_like_tag_not_stripped() -> None:
    parts = parse_all(["<emotion>一段文字</emotion>"])
    assert emotions(parts) == []
    assert joined_text(parts) == "<emotion>一段文字</emotion>"


def test_uppercase_name_not_a_tag() -> None:
    parts = parse_all(["<emo:HAPPY>"])
    assert emotions(parts) == []
    assert joined_text(parts) == "<emo:HAPPY>"


def test_empty_name_not_a_tag() -> None:
    parts = parse_all(["<emo:>"])
    assert emotions(parts) == []
    assert joined_text(parts) == "<emo:>"


# ---------------------------------------------------------------- 名称与空输入


def test_name_with_underscore() -> None:
    assert parse_all(["<emo:very_happy>"]) == [EmotionPart("very_happy")]


def test_empty_feed_returns_nothing() -> None:
    parser = EmotionTagParser()
    assert parser.feed("") == []
    assert parser.flush() == []


def test_empty_stream_flush() -> None:
    assert parse_all([]) == []


# ---------------------------------------------------------------- 任意切分下的一致性


def test_various_chunk_sizes_yield_same_result() -> None:
    """任何切分粒度下：干净文本与情绪序列都保持一致（模拟真实流式边界）。"""
    text = "你好<emo:happy>今天<emo:thinking>过得<emo:neutral>好吗？"
    expected_text = "你好今天过得好吗？"
    expected_emotions = ["happy", "thinking", "neutral"]

    for size in range(1, 12):
        chunks = [text[i : i + size] for i in range(0, len(text), size)]
        parts = parse_all(chunks)
        assert joined_text(parts) == expected_text, f"chunk_size={size}"
        assert emotions(parts) == expected_emotions, f"chunk_size={size}"


def test_various_chunk_sizes_with_unclosed_tail() -> None:
    """带未闭合尾巴时，任意切分下也应还原成原文。"""
    text = "你好<emo:happy>世界<emo:sa"
    expected_emotions = ["happy"]
    expected_text = "你好世界<emo:sa"

    for size in range(1, 8):
        chunks = [text[i : i + size] for i in range(0, len(text), size)]
        parts = parse_all(chunks)
        assert joined_text(parts) == expected_text, f"chunk_size={size}"
        assert emotions(parts) == expected_emotions, f"chunk_size={size}"
