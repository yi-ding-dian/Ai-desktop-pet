"""modules/memory/store.py 单测：memories CRUD + 规则召回排序 + 相似度。

覆盖：
- CRUD（含 kind 归一 / importance 截断 / 空文本拒绝 / 删除）；
- 召回分档：≤50 全量（importance 降序 + 时间倒序）；>50 规则排序 top-8
  （关键词命中优先、importance 次之、时间衰减兜底）；
- 相似度（去重基础）与关键词切分。
"""

from __future__ import annotations

import asyncio
import sqlite3

from backend.modules.memory.store import (
    FULL_RECALL_LIMIT,
    RECALL_TOP_K,
    MemoryStore,
    extract_keywords,
    similarity,
)
from backend.shared.db import connect_db

DAY_MS = 86_400_000


def make_store(tmp_path) -> tuple[sqlite3.Connection, MemoryStore]:
    conn = connect_db(tmp_path / "pet.db")
    return conn, MemoryStore(conn)


# ---------------------------------------------------------------- CRUD


def test_add_and_get(tmp_path) -> None:
    conn, store = make_store(tmp_path)
    memory = store.add("用户叫张三", "fact", 0.9, created_at=100)
    assert memory.id > 0
    assert memory.text == "用户叫张三"
    assert memory.kind == "fact"
    assert memory.importance == 0.9
    assert store.get(memory.id) == memory
    assert store.count() == 1
    conn.close()


def test_add_normalizes_kind_and_importance(tmp_path) -> None:
    conn, store = make_store(tmp_path)
    assert store.add("x", "unknown-kind", 0.5).kind == "fact"  # 非法 kind 归一
    assert store.add("y", "fact", 1.7).importance == 1.0  # 上截断
    assert store.add("z", "fact", -0.2).importance == 0.0  # 下截断
    conn.close()


def test_add_rejects_empty_text(tmp_path) -> None:
    conn, store = make_store(tmp_path)
    try:
        store.add("   ", "fact", 0.5)
    except ValueError:
        pass
    else:  # pragma: no cover
        raise AssertionError("空文本应拒绝")
    conn.close()


def test_delete_and_list(tmp_path) -> None:
    conn, store = make_store(tmp_path)
    a = store.add("a", "fact", 0.5)
    b = store.add("b", "event", 0.5)
    assert [m.id for m in store.list_all()] == [a.id, b.id]
    assert store.delete(a.id) is True
    assert store.delete(a.id) is False
    assert [m.id for m in store.list_all()] == [b.id]
    conn.close()


def test_mark_used(tmp_path) -> None:
    conn, store = make_store(tmp_path)
    m = store.add("a", "fact", 0.5)
    assert m.last_used_at is None
    store.mark_used([m.id], used_at=1234)
    assert store.get(m.id).last_used_at == 1234
    conn.close()


# ---------------------------------------------------------------- 相似度 / 关键词


def test_similarity_identical_and_different() -> None:
    assert similarity("用户喜欢喝拿铁咖啡", "用户喜欢喝拿铁咖啡") == 1.0
    assert similarity("用户喜欢喝拿铁咖啡", "明天天气晴朗") < 0.2
    # 高度相似（个别字差异）：超过去重阈值
    assert similarity("用户喜欢喝拿铁咖啡", "用户喜欢喝拿铁咖啡哦") > 0.65


def test_find_similar(tmp_path) -> None:
    conn, store = make_store(tmp_path)
    store.add("用户喜欢喝拿铁咖啡", "preference", 0.6)
    hit = store.find_similar("用户喜欢喝拿铁咖啡")
    assert hit is not None and hit.text == "用户喜欢喝拿铁咖啡"
    assert store.find_similar("用户养了一只猫") is None
    conn.close()


def test_extract_keywords() -> None:
    keywords = extract_keywords("拿铁 coffee 123")
    assert "coffee" in keywords and "123" in keywords
    assert "拿铁" in keywords
    assert extract_keywords("") == set()


# ---------------------------------------------------------------- 召回：分档与排序


def test_recall_empty_store(tmp_path) -> None:
    conn, store = make_store(tmp_path)
    assert asyncio.run(store.recall("随便问点什么")) == []
    conn.close()


def test_recall_full_mode_sorted_by_importance_then_time(tmp_path) -> None:
    conn, store = make_store(tmp_path)
    base = 1_700_000_000_000
    store.add("低重要 旧", "fact", 0.2, created_at=base - 1000)
    store.add("高重要 旧", "fact", 0.9, created_at=base - 2000)
    store.add("高重要 新", "fact", 0.9, created_at=base)

    result = asyncio.run(store.recall("任意输入", now=base))
    # ≤50：全量返回，按 importance 降序 + 时间倒序
    assert [m.text for m in result] == ["高重要 新", "高重要 旧", "低重要 旧"]
    conn.close()


def test_recall_full_mode_at_threshold_returns_all(tmp_path) -> None:
    conn, store = make_store(tmp_path)
    for i in range(FULL_RECALL_LIMIT):
        store.add(f"记忆{i}", "fact", 0.5, created_at=i)
    result = asyncio.run(store.recall("任意"))
    assert len(result) == FULL_RECALL_LIMIT  # 恰好 50 条：全量不截断
    conn.close()


def test_recall_over_threshold_keyword_hit_ranks_first(tmp_path) -> None:
    """>50 条：关键词命中的记忆应排到最前（即使 importance 低、时间旧）。"""
    conn, store = make_store(tmp_path)
    base = 1_700_000_000_000
    for i in range(FULL_RECALL_LIMIT + 7):
        store.add(f"通用记忆条目 {i}", "fact", 0.9, created_at=base - i * 1000)
    target = store.add(
        "用户喜欢喝拿铁咖啡", "preference", 0.3, created_at=base - 90 * DAY_MS
    )

    result = asyncio.run(store.recall("拿铁咖啡好喝吗", now=base))
    assert len(result) == RECALL_TOP_K
    assert result[0].id == target.id
    conn.close()


def test_recall_over_threshold_topk_count_and_importance_tiebreak(tmp_path) -> None:
    """>50 条且无关键词命中时：top-8 由 importance + 时间衰减决定。"""
    conn, store = make_store(tmp_path)
    base = 1_700_000_000_000
    for i in range(FULL_RECALL_LIMIT + 5):
        store.add(f"通用记忆条目 {i}", "fact", 0.1, created_at=base - 400 * DAY_MS)
    important = store.add("用户名叫张三", "fact", 0.95, created_at=base - 400 * DAY_MS)

    result = asyncio.run(store.recall("完全无关的查询内容", now=base))
    assert len(result) == RECALL_TOP_K
    assert result[0].id == important.id  # importance 明显更高者居首
    conn.close()


def test_recall_over_threshold_recency_decay(tmp_path) -> None:
    """>50 条、关键词与 importance 相同时，新记忆排在旧记忆之前（时间衰减）。"""
    conn, store = make_store(tmp_path)
    base = 1_700_000_000_000
    for i in range(FULL_RECALL_LIMIT + 5):
        store.add(f"通用记忆条目 {i}", "fact", 0.1, created_at=base - 400 * DAY_MS)
    old = store.add("用户喜欢喝拿铁咖啡", "preference", 0.4, created_at=base - 300 * DAY_MS)
    fresh = store.add("用户喜欢喝拿铁咖啡", "preference", 0.4, created_at=base - 1 * DAY_MS)

    result = asyncio.run(store.recall("拿铁咖啡", now=base))
    texts = [m.id for m in result[:2]]
    assert texts == [fresh.id, old.id]
    conn.close()
