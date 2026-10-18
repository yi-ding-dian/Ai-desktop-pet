"""记忆本域（2026-10-18）：用户明确要求记住的链接 / 本机路径 / 短文本。

- ``store``：saved_items 表读写、值校验、自动起名、遗忘名单；
- ``paths``：本机路径归一化与"是否允许删除"判定（只判定，不删除）；
- ``format``：注入 system prompt 的紧凑清单（名字 + 类型；值不注入）。

与长期记忆（``modules/memory``）分工见 ``store.py`` 文件头。
"""

from backend.modules.notebook.format import build_notebook_block
from backend.modules.notebook.paths import (
    deletable_block_reason,
    normalize_existing_path,
    normalize_path,
    protected_reason,
)
from backend.modules.notebook.store import (
    FORGOTTEN_TTL_MS,
    KINDS,
    ItemNotFound,
    NameConflict,
    NotebookError,
    NotebookStore,
    SavedItem,
    SaveOutcome,
    detect_kind,
    name_key,
    normalize_link,
    normalize_name,
    normalize_text,
)

__all__ = [
    "FORGOTTEN_TTL_MS",
    "KINDS",
    "ItemNotFound",
    "NameConflict",
    "NotebookError",
    "NotebookStore",
    "SavedItem",
    "SaveOutcome",
    "build_notebook_block",
    "deletable_block_reason",
    "detect_kind",
    "name_key",
    "normalize_existing_path",
    "normalize_link",
    "normalize_name",
    "normalize_path",
    "normalize_text",
    "protected_reason",
]
