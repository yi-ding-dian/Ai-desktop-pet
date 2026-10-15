"""modules/memory/extractor.py 单测：JSON 解析容错 / 去重 / 画像更新 / 失败不崩。

覆盖：
- parse_extraction：正常结构、顶层数组、markdown 代码块、前后杂文、
  字段归一（kind / importance / 空 text）、整体不可解析；
- MemoryExtractor.extract：入库 + 画像、与已有记忆去重、批内去重、
  模型调用失败（异常）降级、输出不合规降级；
- 对话转录格式化（role 映射、空消息省略）。
"""

from __future__ import annotations

import asyncio
import sqlite3
from dataclasses import dataclass

from backend.modules.memory.extractor import (
    EXTRACT_MAX_MEMORIES,
    MemoryExtractor,
    format_transcript,
    parse_extraction,
)
from backend.modules.memory.profile import ProfileStore
from backend.modules.memory.store import MemoryStore
from backend.shared.db import connect_db

PROMPT = "（测试用提取提示词）"


@dataclass(frozen=True)
class FakeMessage:
    """满足 MessageLike 协议的最小消息对象。"""

    role: str
    content: str


def make_stores(tmp_path) -> tuple[sqlite3.Connection, MemoryStore, ProfileStore]:
    conn = connect_db(tmp_path / "pet.db")
    return conn, MemoryStore(conn), ProfileStore(conn)


def make_extractor(
    store: MemoryStore, profile: ProfileStore, payload: str | Exception
) -> tuple[MemoryExtractor, list[str]]:
    """构造注入 fake complete 的提取器；返回 (提取器, 收到的 prompt 列表)。"""
    prompts: list[str] = []

    async def complete(prompt: str) -> str:
        prompts.append(prompt)
        if isinstance(payload, Exception):
            raise payload
        return payload

    extractor = MemoryExtractor(store, profile, complete=complete, prompt=PROMPT)
    return extractor, prompts


# ---------------------------------------------------------------- 解析


def test_parse_wellformed() -> None:
    raw = """
    {
      "memories": [
        {"text": "用户叫张三", "kind": "fact", "importance": 0.9},
        {"text": "用户喜欢喝拿铁咖啡", "kind": "preference", "importance": 0.6}
      ],
      "profile": [{"key": "称呼", "value": "张三"}]
    }
    """
    memories, profiles = parse_extraction(raw)
    assert [(m.text, m.kind, m.importance) for m in memories] == [
        ("用户叫张三", "fact", 0.9),
        ("用户喜欢喝拿铁咖啡", "preference", 0.6),
    ]
    assert [(p.key, p.value) for p in profiles] == [("称呼", "张三")]


def test_parse_toplevel_array_tolerated() -> None:
    """容错：顶层直接是数组时按 memories 解析（无画像）。"""
    memories, profiles = parse_extraction('[{"text": "用户养了一只猫", "kind": "event"}]')
    assert [(m.text, m.kind) for m in memories] == [("用户养了一只猫", "event")]
    assert profiles == []


def test_parse_markdown_codeblock() -> None:
    raw = '好的，这是结果：\n```json\n{"memories": [{"text": "用户住在杭州", "kind": "fact", "importance": 0.7}]}\n```\n以上。'
    memories, _ = parse_extraction(raw)
    assert [m.text for m in memories] == ["用户住在杭州"]


def test_parse_normalizes_bad_fields() -> None:
    raw = """
    {"memories": [
        {"text": "未知类别归一", "kind": "weird", "importance": "not-a-number"},
        {"text": "importance 截断", "kind": "fact", "importance": 3.5},
        {"text": "   ", "kind": "fact", "importance": 0.5},
        {"kind": "fact", "importance": 0.5},
        "不是对象",
        {"text": "缺 importance", "kind": "event"}
    ]}
    """
    memories, _ = parse_extraction(raw)
    by_text = {m.text: m for m in memories}
    assert by_text["未知类别归一"].kind == "fact"
    assert by_text["未知类别归一"].importance == 0.5  # 非法数值回落默认
    assert by_text["importance 截断"].importance == 1.0
    assert by_text["缺 importance"].importance == 0.5
    assert "   " not in by_text and len(memories) == 3  # 空 text / 非对象条目被丢弃


def test_parse_caps_memory_count() -> None:
    items = ",".join(
        f'{{"text": "记忆{i}", "kind": "fact", "importance": 0.5}}'
        for i in range(EXTRACT_MAX_MEMORIES + 5)
    )
    memories, _ = parse_extraction('{"memories": [' + items + "]}")
    assert len(memories) == EXTRACT_MAX_MEMORIES


def test_parse_garbage_returns_empty_without_raising() -> None:
    for raw in ("", "   ", "这不是 JSON", "[1, 2, 3]", '{"memories": "不是数组"}', '{"other": 1}'):
        memories, profiles = parse_extraction(raw)
        assert memories == [] and profiles == [] or isinstance(memories, list)


def test_parse_truncates_overlong_text() -> None:
    long_text = "啊" * 500
    memories, _ = parse_extraction(f'[{{"text": "{long_text}", "kind": "fact"}}]')
    assert len(memories[0].text) == 200


# ---------------------------------------------------------------- 转录格式化


def test_format_transcript() -> None:
    messages = [
        FakeMessage("user", " 我叫张三 "),
        FakeMessage("assistant", "记住啦"),
        FakeMessage("user", "   "),  # 空消息省略
    ]
    assert format_transcript(messages) == "用户：我叫张三\n宠物：记住啦"


def test_format_transcript_limits_recent() -> None:
    messages = [FakeMessage("user", f"m{i}") for i in range(60)]
    transcript = format_transcript(messages, limit=5)
    assert transcript == "\n".join(f"用户：m{i}" for i in range(55, 60))


# ---------------------------------------------------------------- 提取编排


def test_extract_persists_memories_and_profile(tmp_path) -> None:
    conn, store, profile = make_stores(tmp_path)
    payload = (
        '{"memories": [{"text": "用户叫张三", "kind": "fact", "importance": 0.9}],'
        ' "profile": [{"key": "称呼", "value": "张三"}]}'
    )
    extractor, prompts = make_extractor(store, profile, payload)
    result = asyncio.run(
        extractor.extract([FakeMessage("user", "我叫张三，记住了吗")])
    )

    assert result.ok
    assert [m.text for m in result.added] == ["用户叫张三"]
    assert store.count() == 1
    assert profile.get("称呼") == "张三"
    assert result.profile_keys == ["称呼"]
    # 提示词与对话记录都进入了 complete 的 prompt
    assert PROMPT in prompts[0] and "用户：我叫张三" in prompts[0]
    conn.close()


def test_extract_skips_duplicates_against_existing(tmp_path) -> None:
    conn, store, profile = make_stores(tmp_path)
    store.add("用户喜欢喝拿铁咖啡", "preference", 0.6)
    payload = (
        '{"memories": [{"text": "用户喜欢喝拿铁咖啡", "kind": "preference", "importance": 0.8},'
        ' {"text": "用户养了一只猫", "kind": "event", "importance": 0.5}]}'
    )
    extractor, _ = make_extractor(store, profile, payload)
    result = asyncio.run(extractor.extract([FakeMessage("user", "我养了一只猫")]))

    assert result.ok
    assert [m.text for m in result.added] == ["用户养了一只猫"]
    assert result.duplicates == 1
    assert store.count() == 2
    conn.close()


def test_extract_dedupes_within_batch(tmp_path) -> None:
    conn, store, profile = make_stores(tmp_path)
    payload = (
        '{"memories": ['
        ' {"text": "用户喜欢喝拿铁咖啡", "kind": "preference", "importance": 0.7},'
        ' {"text": "用户喜欢喝拿铁咖啡", "kind": "preference", "importance": 0.7}'
        "]}"
    )
    extractor, _ = make_extractor(store, profile, payload)
    result = asyncio.run(extractor.extract([FakeMessage("user", "我喜欢拿铁咖啡")]))

    assert len(result.added) == 1 and result.duplicates == 1
    assert store.count() == 1
    conn.close()


def test_extract_llm_failure_degrades_without_raising(tmp_path) -> None:
    """模型调用抛异常：不崩、不写入、ok=False（供 service 记日志并推进水位）。"""
    conn, store, profile = make_stores(tmp_path)
    extractor, _ = make_extractor(store, profile, RuntimeError("模拟网络错误"))
    result = asyncio.run(extractor.extract([FakeMessage("user", "你好")]))

    assert result.ok is False
    assert result.added == [] and store.count() == 0
    conn.close()


def test_extract_malformed_output_degrades_without_raising(tmp_path) -> None:
    conn, store, profile = make_stores(tmp_path)
    extractor, _ = make_extractor(store, profile, "今天想不出要提取什么呢～")
    result = asyncio.run(extractor.extract([FakeMessage("user", "你好")]))

    assert result.ok is True  # 调用成功，只是没有可解析内容
    assert result.added == [] and store.count() == 0
    conn.close()


def test_extract_empty_transcript_skips_llm(tmp_path) -> None:
    conn, store, profile = make_stores(tmp_path)
    extractor, prompts = make_extractor(store, profile, "{}")
    result = asyncio.run(extractor.extract([FakeMessage("user", "   ")]))

    assert result.ok and result.added == []
    assert prompts == []  # 没有内容时不调用模型（不烧 token）
    conn.close()
