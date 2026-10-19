"""记忆本域（2026-10-18）：用户明确要求记住的链接 / 本机路径 / 短文本 /
可执行程序（2026-10-19）。

- ``store``：saved_items 表读写、值校验、自动起名、遗忘名单；
- ``paths``：本机路径归一化与"是否允许删除"判定（只判定，不删除）；
- ``programs``：可执行程序路径校验（只判定，不启动）；
- ``format``：注入 system prompt 的紧凑清单（名字 + 类型；值不注入）。

与长期记忆（``modules/memory``）分工见 ``store.py`` 文件头。
"""

from backend.modules.memory_book.format import build_memory_book_block
from backend.modules.memory_book.paths import (
    deletable_block_reason,
    normalize_existing_path,
    normalize_path,
    protected_reason,
)
from backend.modules.memory_book.programs import (
    normalize_program_path,
    program_block_reason,
    program_ok,
)
from backend.modules.memory_book.store import (
    FORGOTTEN_TTL_MS,
    KINDS,
    ItemNotFound,
    NameConflict,
    MemoryBookError,
    MemoryBookStore,
    SavedItem,
    SaveOutcome,
    detect_kind,
    name_key,
    normalize_link,
    normalize_name,
    normalize_text,
    resolve_kind,
)

__all__ = [
    "FORGOTTEN_TTL_MS",
    "KINDS",
    "ItemNotFound",
    "NameConflict",
    "MemoryBookError",
    "MemoryBookStore",
    "SavedItem",
    "SaveOutcome",
    "build_memory_book_block",
    "deletable_block_reason",
    "detect_kind",
    "name_key",
    "normalize_existing_path",
    "normalize_link",
    "normalize_name",
    "normalize_path",
    "normalize_program_path",
    "normalize_text",
    "program_block_reason",
    "program_ok",
    "protected_reason",
    "resolve_kind",
]
