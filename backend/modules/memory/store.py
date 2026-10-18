"""长期记忆存储与召回（§4.3 长期层：memories 表）。

**P3 降级说明（重要）**：内网 LLM 网关不支持 embedding（实测 4 个模型名全 503），
设计文档 §4.3 的「embed → sqlite-vec KNN top-k」本次不可用，降级为
**结构化记忆 + 规则召回**：

- 记忆条数 ≤ ``FULL_RECALL_LIMIT``（50）时**全量返回**（小规模下最有效：
  条目少时全部注入的上下文成本可接受，且不会漏）；
- 超过阈值时按 **关键词命中 + importance + 时间衰减** 打分取 top-K（默认 8）。

**向量实现接入点（将来）**：
:meth:`MemoryStore.recall` 已设计为 **async + 只依赖 query 文本** 的可替换签名——
将来网关支持 embedding（或换本地模型）时，新增 ``VectorRecaller``（内部先
``llm.provider.embed(query)`` 再查 ``memories_vec`` KNN），由 application 装配层
以依赖注入方式替换本类的规则实现；调用方（chat_pipeline / memory_service）
无需改动。sqlite-vec 虚拟表的建表接入点见 ``shared/db.py`` 文件头注释。
记忆写入路径（extractor）同理：届时在入库时补一次 embed 写 ``memories_vec``。

**依赖的 embedding 能力**：``modules/llm/provider.py`` 的 ``embed`` 协议方法
（当前 ``OpenAICompatProvider.embed`` 为 ``NotImplementedError`` 占位）——
本网关不具备该能力，故本文件不做任何 embedding 调用；向量实现落地时，
embed 能力经 application 注入，memory 域仍不直接 import llm 域实现。

去重相似度同样受此影响：当前用**字符 bigram Dice 系数**做近似（无向量），
阈值见 ``SIMILARITY_THRESHOLD``；向量可用后可直接替换为余弦相似度。
"""

from __future__ import annotations

import math
import re
import sqlite3
import time
from dataclasses import dataclass
from typing import Any

#: 记忆类别（§4.3：事实 / 偏好 / 事件）
KIND_VALUES = ("fact", "preference", "event")

#: 召回分档：记忆条数 ≤ 此值时全量返回（按 importance 降序 + 时间倒序）
FULL_RECALL_LIMIT = 50
#: 超阈值时的 top-K
RECALL_TOP_K = 8

#: 规则打分权重（关键词命中最优先；importance 次之；时间衰减兜底）
W_KEYWORD = 2.0
W_IMPORTANCE = 1.0
W_RECENCY = 0.5
#: 时间衰减半衰期（天）：score 中 recency = 0.5 ** (age_days / 此值)
RECENCY_HALF_LIFE_DAYS = 30.0

#: 去重相似度阈值（字符 bigram Dice 系数；=1 完全相同，>0.65 视为同一记忆）
SIMILARITY_THRESHOLD = 0.65

#: 记忆文本长度上限（防模型输出超长条目污染上下文）
MAX_MEMORY_TEXT_LEN = 200

#: 关键词切分：英文/数字 token 或连续中文段
_TOKEN_RE = re.compile(r"[A-Za-z0-9_]+|[一-鿿]+")


def _now_ms() -> int:
    return int(time.time() * 1000)


@dataclass(frozen=True)
class Memory:
    """一条长期记忆。"""

    id: int
    text: str
    kind: str
    importance: float
    created_at: int
    last_used_at: int | None = None


def extract_keywords(text: str) -> set[str]:
    """轻量"分词"（规则召回的关键词来源，无第三方分词依赖）。

    - 英文/数字：小写后整词为一个关键词；
    - 中文连续段：切字符 bigram（长度 1 的段保留整段）——中文常用词多为
      二字词，bigram 命中已能反映相关性，且实现零依赖、行为可预期。
    """
    keywords: set[str] = set()
    for token in _TOKEN_RE.findall(text or ""):
        if token.isascii():
            keywords.add(token.lower())
            continue
        if len(token) == 1:
            keywords.add(token)
        else:
            for i in range(len(token) - 1):
                keywords.add(token[i : i + 2])
    return keywords


def _bigrams(text: str) -> set[str]:
    """字符 bigram 集合（相似度用；空白剥离，降低排版差异带来的噪声）。"""
    compact = "".join((text or "").split())
    if not compact:
        return set()
    if len(compact) == 1:
        return {compact}
    return {compact[i : i + 2] for i in range(len(compact) - 1)}


def similarity(a: str, b: str) -> float:
    """文本相似度（字符 bigram Dice 系数，0~1）。

    替代方案说明：无 embedding 时用车字符级近似做"高度相似则跳过"的判定；
    向量可用后应替换为余弦相似度（阈值语义同步调整）。
    """
    if a is None or b is None:
        return 0.0
    if a == b:
        return 1.0
    ga, gb = _bigrams(a), _bigrams(b)
    if not ga or not gb:
        return 0.0
    return 2.0 * len(ga & gb) / (len(ga) + len(gb))


def _row_to_memory(row: sqlite3.Row) -> Memory:
    return Memory(
        id=int(row["id"]),
        text=str(row["text"]),
        kind=str(row["kind"]),
        importance=float(row["importance"]),
        created_at=int(row["created_at"]),
        last_used_at=int(row["last_used_at"]) if row["last_used_at"] is not None else None,
    )


class MemoryStore:
    """memories 表 CRUD + 规则召回。"""

    def __init__(self, conn: sqlite3.Connection) -> None:
        self._conn = conn

    # ---------- CRUD ----------

    def add(
        self,
        text: str,
        kind: str = "fact",
        importance: float = 0.5,
        *,
        created_at: int | None = None,
    ) -> Memory:
        """写入一条记忆并返回（含 id）。text 为空抛 ValueError。"""
        text = (text or "").strip()
        if not text:
            raise ValueError("记忆文本不能为空")
        kind = kind if kind in KIND_VALUES else "fact"
        importance = max(0.0, min(1.0, float(importance)))
        cursor = self._conn.execute(
            "INSERT INTO memories (text, kind, importance, created_at) VALUES (?, ?, ?, ?)",
            (text, kind, importance, created_at if created_at is not None else _now_ms()),
        )
        assert cursor.lastrowid is not None
        memory = self.get(int(cursor.lastrowid))
        assert memory is not None
        return memory

    def get(self, memory_id: int) -> Memory | None:
        row = self._conn.execute(
            "SELECT * FROM memories WHERE id = ?", (memory_id,)
        ).fetchone()
        return _row_to_memory(row) if row is not None else None

    def list_all(self) -> list[Memory]:
        """全部记忆（按 id 升序，即写入顺序）。"""
        rows = self._conn.execute("SELECT * FROM memories ORDER BY id ASC").fetchall()
        return [_row_to_memory(row) for row in rows]

    def count(self) -> int:
        row = self._conn.execute("SELECT COUNT(*) AS n FROM memories").fetchone()
        return int(row["n"])

    def delete(self, memory_id: int) -> bool:
        """删除一条记忆；返回是否确有删除（记忆管理页/测试用）。"""
        cursor = self._conn.execute("DELETE FROM memories WHERE id = ?", (memory_id,))
        return cursor.rowcount > 0

    def delete_containing(self, value: str) -> int:
        """删除所有包含 ``value`` 的记忆，返回删除条数（记忆本"忘掉"联动清理用）。

        用 ``instr(lower(...))`` 做**字面**子串匹配，而不是 ``LIKE``——URL/路径里
        常见 ``%`` / ``_``，LIKE 通配符会误伤。大小写折叠后比较（URL/路径通常是
        ASCII；中文不受影响）。值太短时由调用方（记忆本服务）自行跳过，避免误删。
        """
        needle = (value or "").strip()
        if not needle:
            return 0
        cursor = self._conn.execute(
            "DELETE FROM memories WHERE instr(lower(text), lower(?)) > 0", (needle,)
        )
        return max(0, cursor.rowcount)

    def find_similar(self, text: str, *, threshold: float = SIMILARITY_THRESHOLD) -> Memory | None:
        """在已有记忆中找与 text 高度相似的一条（去重前置检查）。

        线性扫描 + 字符级相似度：记忆量级为百条以内，成本可忽略；
        向量可用后此函数同样可替换为 KNN 查询。
        """
        best: Memory | None = None
        best_score = threshold
        for memory in self.list_all():
            score = similarity(text, memory.text)
            if score >= best_score:
                best_score = score
                best = memory
        return best

    def mark_used(self, ids: list[int], *, used_at: int | None = None) -> None:
        """标记记忆在本次对话中被使用（更新 last_used_at；不参与召回打分）。"""
        if not ids:
            return
        stamp = used_at if used_at is not None else _now_ms()
        self._conn.executemany(
            "UPDATE memories SET last_used_at = ? WHERE id = ?",
            [(stamp, int(memory_id)) for memory_id in ids],
        )

    # ---------- 召回 ----------

    async def recall(
        self,
        query: str,
        *,
        limit: int = RECALL_TOP_K,
        now: int | None = None,
    ) -> list[Memory]:
        """召回与 query 相关的记忆（**可替换签名**，见模块 docstring）。

        - async：为将来的向量实现预留（embed 是网络调用）；当前规则实现内部
          无 await，行为等价于同步。
        - ``limit``：仅分档模式（记忆数 > FULL_RECALL_LIMIT）下生效的 top-K。
        """
        memories = self.list_all()
        if not memories:
            return []
        current = now if now is not None else _now_ms()
        if len(memories) <= FULL_RECALL_LIMIT:
            # 小规模：全量返回，按 importance 降序 + 时间倒序（新在前）
            return sorted(
                memories, key=lambda m: (-m.importance, -m.created_at, -m.id)
            )
        query_keywords = extract_keywords(query or "")
        scored = [(self._score(m, query_keywords, current), m) for m in memories]
        scored.sort(key=lambda item: (-item[0], -item[1].created_at, -item[1].id))
        return [memory for _, memory in scored[: max(1, int(limit))]]

    @staticmethod
    def _score(memory: Memory, query_keywords: set[str], now_ms: int) -> float:
        """规则打分：关键词命中 + importance + 时间衰减。"""
        hit = len(extract_keywords(memory.text) & query_keywords)
        age_days = max(0.0, (now_ms - memory.created_at) / 86_400_000.0)
        recency = math.pow(0.5, age_days / RECENCY_HALF_LIFE_DAYS)
        return W_KEYWORD * hit + W_IMPORTANCE * memory.importance + W_RECENCY * recency
