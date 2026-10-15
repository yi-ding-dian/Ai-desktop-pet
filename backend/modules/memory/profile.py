"""用户画像 KV 读写（§4.3 画像层：profile 表）。

画像条目是结构化信息（称呼/姓名/城市/职业/喜好……），相比长期记忆文本
更适合直接全量注入上下文（条数少、信息密度高）：上下文注入格式见
``modules/memory/format.py``。
"""

from __future__ import annotations

import sqlite3
import time
from dataclasses import dataclass

#: 画像 key/value 长度上限（防模型输出异常长的条目污染上下文）
MAX_KEY_LEN = 32
MAX_VALUE_LEN = 200


def _now_ms() -> int:
    return int(time.time() * 1000)


@dataclass(frozen=True)
class ProfileItem:
    """一条画像 KV。"""

    key: str
    value: str
    updated_at: int


class ProfileStore:
    """profile 表读写（key 唯一，set 为 UPSERT 语义）。"""

    def __init__(self, conn: sqlite3.Connection) -> None:
        self._conn = conn

    def set(self, key: str, value: str, *, updated_at: int | None = None) -> ProfileItem:
        """写入/覆盖画像条目；key 或 value 为空抛 ValueError。"""
        key = (key or "").strip()[:MAX_KEY_LEN]
        value = (value or "").strip()[:MAX_VALUE_LEN]
        if not key or not value:
            raise ValueError("画像 key/value 不能为空")
        stamp = updated_at if updated_at is not None else _now_ms()
        self._conn.execute(
            "INSERT INTO profile (key, value, updated_at) VALUES (?, ?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
            (key, value, stamp),
        )
        return ProfileItem(key=key, value=value, updated_at=stamp)

    def get(self, key: str) -> str | None:
        row = self._conn.execute(
            "SELECT value FROM profile WHERE key = ?", ((key or "").strip(),)
        ).fetchone()
        return str(row["value"]) if row is not None else None

    def all(self) -> list[ProfileItem]:
        """全部画像条目（最近更新在前，key 字典序兜底——注入顺序稳定）。"""
        rows = self._conn.execute(
            "SELECT key, value, updated_at FROM profile ORDER BY updated_at DESC, key ASC"
        ).fetchall()
        return [
            ProfileItem(
                key=str(row["key"]), value=str(row["value"]), updated_at=int(row["updated_at"])
            )
            for row in rows
        ]

    def delete(self, key: str) -> bool:
        cursor = self._conn.execute("DELETE FROM profile WHERE key = ?", ((key or "").strip(),))
        return cursor.rowcount > 0

    def count(self) -> int:
        row = self._conn.execute("SELECT COUNT(*) AS n FROM profile").fetchone()
        return int(row["n"])
