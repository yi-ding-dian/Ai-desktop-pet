"""记忆本存储（2026-10-18）：用户明确要求记住的链接 / 本机路径 / 短文本。

**与长期记忆的分工（重要）**：

- ``modules/memory``：关于用户的模糊事实与偏好，后台 LLM 提取、自然语言召回；
- 本域（记忆本）：用户显式说"记住/收藏"的**精确条目**——名字是主键，值原样
  保存；打开时模型只传名字，后端取精确值，不经过模型改写。链接/路径这类
  "一个字符错就打不开"的内容不应该塞进自然语言记忆。

表结构见 ``shared/db.py`` 的 ``saved_items`` / ``forgotten_values``。
本文件只做存储与校验；"该不该删真实文件""删完怎么清记忆"等编排在
``application/notebook_service.py``。
"""

from __future__ import annotations

import os
import re
import sqlite3
import time
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlsplit

from backend.modules.notebook.paths import normalize_existing_path, normalize_path

#: 条目类型
KINDS = ("link", "path", "text")

#: 模型偶尔会传同义词（url/file/folder/note…）：宽容归一，避免整条保存失败
_KIND_ALIASES = {
    "url": "link",
    "网址": "link",
    "链接": "link",
    "file": "path",
    "folder": "path",
    "dir": "path",
    "directory": "path",
    "文件": "path",
    "文件夹": "path",
    "note": "text",
    "memo": "text",
    "文字": "text",
    "文本": "text",
}

#: 名字长度上限（用户以后点名用，太长反而不好说）
MAX_NAME_LEN = 30
#: 链接长度上限（防止模型把整段 HTML 当链接传进来）
MAX_LINK_LEN = 2048
#: 路径长度上限
MAX_PATH_LEN = 1000
#: 短文本长度上限（不是长期记忆，只放以后要原样取回的短内容）
MAX_TEXT_LEN = 500

#: 遗忘名单有效期（30 天）：旧对话早已过后台提取窗口，过期后自动清理
FORGOTTEN_TTL_MS = 30 * 24 * 60 * 60 * 1000

_DOMAIN_RE = re.compile(
    r"(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\.)+[A-Za-z]{2,}(?::\d+)?(?:[/?#].*)?"
)
_TRAILING_PUNCT = "。，；、！？）】」』》\"' \t\r\n"


def _now_ms() -> int:
    return int(time.time() * 1000)


# ---------------------------------------------------------------- 名字 / 值归一化


def normalize_name(name: str) -> str:
    """名字归一化：去首尾空白、压缩内部连续空白。"""
    return " ".join(str(name or "").split())


def name_key(name: str) -> str:
    """唯一键：归一化 + casefold（英文不分大小写；中文原样）。"""
    return normalize_name(name).casefold()


def _validate_name(name: str) -> str:
    cleaned = normalize_name(name)
    if not cleaned:
        raise ValueError("名字不能为空")
    if len(cleaned) > MAX_NAME_LEN:
        raise ValueError(f"名字最多 {MAX_NAME_LEN} 个字")
    return cleaned


def normalize_link(value: str) -> str:
    """校验并归一化网页链接（只允许 http/https）。

    - 用户很常见地只发 ``example.com``：自动补 ``https://``；
    - 容忍模型在链接末尾带中文句号/右括号；
    - 拒绝带用户名/密码的 URL（``https://user:pass@host``），避免把凭据存进记忆本。
    """
    # 只剥引号/尖括号与中文句末标点；不剥 ASCII 括号——URL 路径里可能合法地以
    # “)” 结尾（如维基百科条目），剥掉会把链接改坏。
    raw = str(value or "").strip().strip("\"'<>")
    raw = raw.rstrip(_TRAILING_PUNCT).strip().strip("\"'<>")
    if not raw:
        raise ValueError("链接不能为空")
    if any(ch in raw for ch in (" ", "\n", "\r", "\t")):
        raise ValueError("链接里不能有空白字符")
    if "://" not in raw:
        if _DOMAIN_RE.fullmatch(raw):
            raw = f"https://{raw}"
        else:
            raise ValueError("链接要以 http:// 或 https:// 开头")
    if len(raw) > MAX_LINK_LEN:
        raise ValueError("链接太长了")
    try:
        parts = urlsplit(raw)
    except ValueError as exc:
        raise ValueError(f"链接格式不对：{exc}") from exc
    if parts.scheme.lower() not in ("http", "https") or not parts.netloc:
        raise ValueError("只支持 http/https 网页链接")
    if parts.username or parts.password:
        raise ValueError("链接里不要带用户名/密码")
    return raw


def normalize_text(value: str) -> str:
    """校验短文本（1–500 字；控制字符拒绝）。"""
    text = str(value or "").strip()
    if not text:
        raise ValueError("内容不能为空")
    if len(text) > MAX_TEXT_LEN:
        raise ValueError(f"短文本最多 {MAX_TEXT_LEN} 字")
    if any(ord(ch) < 32 and ch not in "\n\t" for ch in text):
        raise ValueError("内容里有控制字符")
    return text


def detect_kind(value: str) -> str:
    """根据值猜类型（模型没传 kind 时兜底）：链接 → 路径 → 文本。"""
    text = str(value or "").strip()
    if re.match(r"https?://", text, re.IGNORECASE) or _DOMAIN_RE.fullmatch(text):
        return "link"
    expanded = os.path.expandvars(os.path.expanduser(text.strip("\"'")))
    if os.path.isabs(expanded):
        return "path"
    return "text"


def _auto_name_base(kind: str, value: str, *, is_dir: bool = False) -> str:
    """没给名字时的自动起名：链接取域名、路径取末级目录名、文本取前 12 字。"""
    if kind == "link":
        host = (urlsplit(value).hostname or "链接").lower()
        if host.startswith("www."):
            host = host[4:]
        return host
    if kind == "path":
        path = Path(value)
        if path.name:
            return path.name
        drive = path.drive.rstrip(":\\/")
        return f"{drive}盘" if drive else "根目录"
    compact = " ".join(value.split())
    return compact[:12] or "文字"


# ---------------------------------------------------------------- 数据模型


class NotebookError(ValueError):
    """记忆本业务错误（名字冲突/条目不存在等）；message 可直接给用户看。"""


class ItemNotFound(NotebookError):
    """按名字找不到条目。"""


class NameConflict(NotebookError):
    """改名目标已被占用。"""


@dataclass(frozen=True)
class SavedItem:
    """一条记忆本条目。"""

    id: int
    name: str
    kind: str
    value: str
    is_dir: bool
    created_at: int
    updated_at: int

    @property
    def kind_label(self) -> str:
        if self.kind == "link":
            return "链接"
        if self.kind == "path":
            return "文件夹" if self.is_dir else "文件"
        return "文字"


@dataclass(frozen=True)
class SaveOutcome:
    """一次保存的结果。"""

    item: SavedItem
    created: bool
    updated: bool
    old_value: str | None
    auto_name: bool


def _row_to_item(row: sqlite3.Row) -> SavedItem:
    return SavedItem(
        id=int(row["id"]),
        name=str(row["name"]),
        kind=str(row["kind"]),
        value=str(row["value"]),
        is_dir=bool(row["is_dir"]),
        created_at=int(row["created_at"]),
        updated_at=int(row["updated_at"]),
    )


# ---------------------------------------------------------------- 存储


class NotebookStore:
    """saved_items / forgotten_values 两张表的读写。"""

    def __init__(self, conn: sqlite3.Connection) -> None:
        self._conn = conn

    # ---------- 保存 / 查询 ----------

    def save(
        self,
        *,
        name: str = "",
        kind: str | None = None,
        value: str,
        now: int | None = None,
    ) -> SaveOutcome:
        """保存一条（同名则更新值，不新增重复行）。

        - ``name`` 为空时自动起名（域名/末级目录名/前 12 字），重名加 ``-2``；
        - ``kind`` 为空时按值自动判断；
        - 值校验失败抛 ``ValueError``（中文原因，可直接展示）。
        """
        timestamp = now if now is not None else _now_ms()
        raw_value = str(value or "").strip()
        if not raw_value:
            raise ValueError("要记住的内容不能为空")

        if kind is not None:
            kind = _KIND_ALIASES.get(str(kind).strip().lower(), str(kind).strip())
        if kind is not None and kind not in KINDS:
            raise ValueError("类型只能是 link / path / text")
        resolved_kind = kind or detect_kind(raw_value)

        if resolved_kind == "link":
            normalized_value = normalize_link(raw_value)
            is_dir = False
        elif resolved_kind == "path":
            path, is_dir = normalize_existing_path(raw_value)
            normalized_value = str(path)
            if len(normalized_value) > MAX_PATH_LEN:
                raise ValueError("路径太长了")
        else:
            normalized_value = normalize_text(raw_value)
            is_dir = False

        cleaned = normalize_name(name)
        auto_name = False
        if not cleaned:
            cleaned = self._unique_auto_name(
                _auto_name_base(resolved_kind, normalized_value, is_dir=is_dir)
            )
            auto_name = True
        else:
            cleaned = _validate_name(cleaned)

        key = name_key(cleaned)
        existing = self._find_by_key(key)
        if existing is not None:
            if existing.kind == resolved_kind and existing.value == normalized_value:
                return SaveOutcome(
                    item=existing, created=False, updated=False, old_value=None, auto_name=auto_name
                )
            self._conn.execute(
                "UPDATE saved_items SET name = ?, kind = ?, value = ?, is_dir = ?, "
                "updated_at = ? WHERE id = ?",
                (cleaned, resolved_kind, normalized_value, int(is_dir), timestamp, existing.id),
            )
            updated = self.get(existing.id)
            assert updated is not None
            return SaveOutcome(
                item=updated, created=False, updated=True, old_value=existing.value, auto_name=auto_name
            )

        cursor = self._conn.execute(
            "INSERT INTO saved_items "
            "(name, name_key, kind, value, is_dir, created_at, updated_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            (cleaned, key, resolved_kind, normalized_value, int(is_dir), timestamp, timestamp),
        )
        assert cursor.lastrowid is not None
        item = self.get(int(cursor.lastrowid))
        assert item is not None
        return SaveOutcome(item=item, created=True, updated=False, old_value=None, auto_name=auto_name)

    def get(self, item_id: int) -> SavedItem | None:
        row = self._conn.execute(
            "SELECT * FROM saved_items WHERE id = ?", (item_id,)
        ).fetchone()
        return _row_to_item(row) if row is not None else None

    def list_all(self, kind: str | None = None) -> list[SavedItem]:
        """全部条目（最近更新在前）；可按 kind 过滤。"""
        if kind in KINDS:
            rows = self._conn.execute(
                "SELECT * FROM saved_items WHERE kind = ? ORDER BY updated_at DESC, id DESC",
                (kind,),
            ).fetchall()
        else:
            rows = self._conn.execute(
                "SELECT * FROM saved_items ORDER BY updated_at DESC, id DESC"
            ).fetchall()
        return [_row_to_item(row) for row in rows]

    def count(self) -> int:
        row = self._conn.execute("SELECT COUNT(*) AS n FROM saved_items").fetchone()
        return int(row["n"])

    def find_by_name(self, name: str) -> SavedItem | None:
        return self._find_by_key(name_key(name))

    def find_path_items(self, path: str) -> list[SavedItem]:
        """找出指向同一真实路径的条目（Windows 下大小写不敏感）。"""
        try:
            target = os.path.normcase(os.path.realpath(os.path.abspath(path)))
        except OSError:
            target = os.path.normcase(path)
        result: list[SavedItem] = []
        for item in self.list_all("path"):
            try:
                current = os.path.normcase(os.path.realpath(os.path.abspath(item.value)))
            except OSError:
                current = os.path.normcase(item.value)
            if current == target:
                result.append(item)
        return result

    def path_ok(self, item: SavedItem) -> bool:
        """路径条目当前是否仍然存在（供列表/注入时标注）。"""
        if item.kind != "path":
            return True
        try:
            return Path(normalize_path(item.value)).exists()
        except (ValueError, OSError):
            return False

    # ---------- 改名 / 删除 ----------

    def rename(self, old_name: str, new_name: str, *, now: int | None = None) -> SavedItem:
        """改名；旧名不存在抛 ``ItemNotFound``，新名被占用抛 ``NameConflict``。"""
        item = self.find_by_name(old_name)
        if item is None:
            raise ItemNotFound(f"记忆本里没有『{normalize_name(old_name)}』")
        cleaned = _validate_name(new_name)
        key = name_key(cleaned)
        existing = self._find_by_key(key)
        if existing is not None and existing.id != item.id:
            raise NameConflict(f"『{existing.name}』这个名字已经被占用了")
        timestamp = now if now is not None else _now_ms()
        self._conn.execute(
            "UPDATE saved_items SET name = ?, name_key = ?, updated_at = ? WHERE id = ?",
            (cleaned, key, timestamp, item.id),
        )
        updated = self.get(item.id)
        assert updated is not None
        return updated

    def delete(self, name: str) -> SavedItem | None:
        """按名字删除记录；不存在返回 None。"""
        item = self.find_by_name(name)
        if item is None:
            return None
        self._conn.execute("DELETE FROM saved_items WHERE id = ?", (item.id,))
        return item

    # ---------- 遗忘名单 ----------

    @staticmethod
    def _value_key(value: str) -> str:
        return str(value or "").strip().casefold()

    def add_forgotten(
        self, value: str, *, now: int | None = None, ttl_ms: int = FORGOTTEN_TTL_MS
    ) -> None:
        """记下"这个值已经让用户忘掉"（供后台记忆提取过滤）。"""
        key = self._value_key(value)
        if not key:
            return
        stamp = now if now is not None else _now_ms()
        self._conn.execute(
            "INSERT INTO forgotten_values (value_key, created_at, expires_at) "
            "VALUES (?, ?, ?) "
            "ON CONFLICT(value_key) DO UPDATE SET "
            "created_at = excluded.created_at, expires_at = excluded.expires_at",
            (key, stamp, stamp + ttl_ms),
        )

    def clear_forgotten(self, value: str) -> None:
        """重新保存同一个值时解除遗忘（用户又要它了）。"""
        key = self._value_key(value)
        if key:
            self._conn.execute("DELETE FROM forgotten_values WHERE value_key = ?", (key,))

    def purge_expired_forgotten(self, *, now: int | None = None) -> None:
        stamp = now if now is not None else _now_ms()
        self._conn.execute("DELETE FROM forgotten_values WHERE expires_at <= ?", (stamp,))

    def forgotten_keys(self, *, now: int | None = None) -> list[str]:
        """未过期的遗忘值（先清理过期项）。"""
        self.purge_expired_forgotten(now=now)
        rows = self._conn.execute(
            "SELECT value_key FROM forgotten_values ORDER BY created_at DESC"
        ).fetchall()
        return [str(row["value_key"]) for row in rows]

    def is_forgotten_text(self, text: str, *, now: int | None = None) -> bool:
        """一段文本是否包含任一"已遗忘"值（记忆提取入库前过滤用）。"""
        haystack = str(text or "").casefold()
        if not haystack:
            return False
        return any(key in haystack for key in self.forgotten_keys(now=now))

    # ---------- 内部 ----------

    def _find_by_key(self, key: str) -> SavedItem | None:
        row = self._conn.execute(
            "SELECT * FROM saved_items WHERE name_key = ?", (key,)
        ).fetchone()
        return _row_to_item(row) if row is not None else None

    def _unique_auto_name(self, base: str) -> str:
        """自动名去重：``example.com`` → ``example.com-2`` …（最多 99 个后缀）。"""
        cleaned = normalize_name(base)[:MAX_NAME_LEN] or "条目"
        if self._find_by_key(name_key(cleaned)) is None:
            return cleaned
        for index in range(2, 100):
            suffix = f"-{index}"
            candidate = f"{cleaned[: MAX_NAME_LEN - len(suffix)]}{suffix}"
            if self._find_by_key(name_key(candidate)) is None:
                return candidate
        raise NotebookError("自动起名失败：同类条目太多了，请给个名字")
