"""SQLite 轻量封装：连接打开 + 建库（设计文档 §6.2 表结构）。

设计取向（任务书）：
- 只用 Python 内置 ``sqlite3``，不引 ORM、不引迁移框架；
- 建表用 ``CREATE TABLE IF NOT EXISTS`` 幂等执行，进程启动时调用一次；
- 单机单进程（uvicorn 单事件循环）下同步短语句访问，无并发写竞争；
  连接以 ``check_same_thread=False`` 打开（当前所有访问都在事件循环线程内，
  若将来移入 ``asyncio.to_thread`` 需在调用侧自行串行化）。

**向量表说明（P3 实测降级）**：内网 LLM 网关不支持 embedding（4 个模型名
全部 503），因此 §6.2 的 ``memories_vec``（sqlite-vec 虚拟表）**本次不建**，
长期记忆降级为「结构化记忆 + 规则召回」（见 modules/memory/store.py）。
将来网关支持 embedding（或换本地模型）时的接入点：

1. 本文件加 ``CREATE VIRTUAL TABLE memories_vec USING vec0(...)``（需先加载
   sqlite-vec 扩展）；
2. 在 modules/memory/store.py 的召回函数处替换为向量实现——签名已按可替换
   设计（async，接受 query 文本，见该文件顶部注释）。
"""

from __future__ import annotations

import sqlite3
from pathlib import Path

from backend.shared.paths import get_data_dir

#: 数据库文件名（PET_DATA_DIR 下，§6.1/§6.2）
DB_FILE_NAME = "pet.db"

#: 建表语句（§6.2 字段级一致；全部 IF NOT EXISTS，幂等）
SCHEMA_STATEMENTS: tuple[str, ...] = (
    # 会话
    """
    CREATE TABLE IF NOT EXISTS sessions (
      id          TEXT PRIMARY KEY,
      title       TEXT,
      created_at  INTEGER NOT NULL,
      ended_at    INTEGER
    )
    """,
    # 消息历史
    """
    CREATE TABLE IF NOT EXISTS messages (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id  TEXT NOT NULL REFERENCES sessions(id),
      role        TEXT NOT NULL,            -- user / assistant
      content     TEXT NOT NULL,
      emotion     TEXT,                     -- 助手消息的情绪标签
      created_at  INTEGER NOT NULL
    )
    """,
    "CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, created_at)",
    # 长期记忆（结构化；向量列见文件头注释，待 embedding 可用）
    """
    CREATE TABLE IF NOT EXISTS memories (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      text        TEXT NOT NULL,
      kind        TEXT NOT NULL,            -- fact / preference / event
      importance  REAL DEFAULT 0.5,
      created_at  INTEGER NOT NULL,
      last_used_at INTEGER
    )
    """,
    # 用户画像（KV）
    """
    CREATE TABLE IF NOT EXISTS profile (
      key         TEXT PRIMARY KEY,
      value       TEXT NOT NULL,
      updated_at  INTEGER NOT NULL
    )
    """,
)


def get_db_path() -> Path:
    """数据库文件路径（PET_DATA_DIR/pet.db；不保证存在）。"""
    return get_data_dir() / DB_FILE_NAME


def connect_db(path: Path | None = None) -> sqlite3.Connection:
    """打开（必要时创建）pet.db 并确保表结构就绪。

    - WAL 日志模式：读写并发更稳（外部工具查看库时也不阻塞）；
    - 外键打开：messages.session_id 引用 sessions(id)；
    - isolation_level=None：自动提交——本项目每次写一条短语句，无需显式事务。
    """
    db_path = path or get_db_path()
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(db_path, isolation_level=None, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    conn.execute("PRAGMA busy_timeout=5000")
    apply_schema(conn)
    return conn


def apply_schema(conn: sqlite3.Connection) -> None:
    """幂等建表（§6.2）。"""
    for statement in SCHEMA_STATEMENTS:
        conn.execute(statement)
