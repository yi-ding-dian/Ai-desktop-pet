"""modules/notebook + application/notebook_service 单测（2026-10-18）。

覆盖：
- 存储：链接/路径/文本保存、自动起名、同名更新、改名冲突、删除、遗忘名单；
- 服务：批量保存汇总、打开前解析（名字/临时 URL）、删文件前解析
  （删记录 vs 删文件歧义、保护目录）、删记录联动清长期记忆；
- 注入：链接 URL / 本机路径不进入 system 块，文本值进入。
"""

from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

from backend.application.notebook_service import NotebookService
from backend.modules.memory.extractor import ExtractedMemory, MemoryExtractor
from backend.modules.memory.profile import ProfileStore
from backend.modules.memory.store import MemoryStore
from backend.modules.notebook import (
    NameConflict,
    NotebookStore,
    build_notebook_block,
    normalize_link,
)
from backend.shared.db import connect_db


def make_env(tmp_path) -> tuple[sqlite3.Connection, NotebookStore, NotebookService, MemoryStore]:
    conn = connect_db(tmp_path / "pet.db")
    store = NotebookStore(conn)
    memories = MemoryStore(conn)
    service = NotebookService(store, memories)
    return conn, store, service, memories


# ---------------------------------------------------------------- 值校验


def test_normalize_link_adds_scheme_and_rejects_other_schemes() -> None:
    assert normalize_link("example.com/a") == "https://example.com/a"
    assert normalize_link("https://a.com/x。") == "https://a.com/x"
    # 合法的右括号不能被当成句末标点剥掉
    wiki = "https://en.wikipedia.org/wiki/Foo_(bar)"
    assert normalize_link(wiki) == wiki
    with pytest.raises(ValueError):
        normalize_link("ftp://a.com")
    with pytest.raises(ValueError):
        normalize_link("https://user:pass@a.com")


# ---------------------------------------------------------------- 存储


def test_save_link_auto_name_and_upsert(tmp_path) -> None:
    _conn, store, _service, _memories = make_env(tmp_path)
    first = store.save(name="", kind="link", value="https://www.example.com/a")
    assert first.created and first.auto_name
    assert first.item.name == "example.com"
    assert first.item.kind == "link"

    second = store.save(name="example.com", kind="link", value="https://example.com/b")
    assert second.updated and not second.created
    assert second.old_value == "https://www.example.com/a"
    assert second.item.value == "https://example.com/b"
    assert store.count() == 1


def test_auto_name_collision_gets_suffix(tmp_path) -> None:
    _conn, store, _service, _memories = make_env(tmp_path)
    first = store.save(kind="link", value="https://example.com/a")
    second = store.save(kind="link", value="https://example.com/b")
    assert first.item.name == "example.com"
    assert second.item.name == "example.com-2"


def test_save_path_requires_existing(tmp_path) -> None:
    _conn, store, _service, _memories = make_env(tmp_path)
    folder = tmp_path / "项目目录"
    folder.mkdir()
    outcome = store.save(kind="path", value=str(folder))
    assert outcome.item.kind == "path"
    assert outcome.item.is_dir is True
    assert outcome.item.name == "项目目录"

    # 模型偶尔传 file/folder/url 等同义词：归一后保存
    legacy = store.save(name="文件", kind="folder", value=str(folder))
    assert legacy.item.kind == "path"

    with pytest.raises(ValueError, match="不存在"):
        store.save(kind="path", value=str(tmp_path / "没有这个"))


def test_save_text_and_rename_conflict(tmp_path) -> None:
    _conn, store, _service, _memories = make_env(tmp_path)
    store.save(name="快递单号", kind="text", value="SF123456789")
    store.save(name="博客", kind="link", value="https://a.com")
    with pytest.raises(NameConflict):
        store.rename("博客", "快递单号")

    renamed = store.rename("快递单号", "单号")
    assert renamed.name == "单号"
    assert store.find_by_name("快递单号") is None


def test_path_ok_and_delete(tmp_path) -> None:
    _conn, store, _service, _memories = make_env(tmp_path)
    folder = tmp_path / "临时目录"
    folder.mkdir()
    item = store.save(name="临时", kind="path", value=str(folder)).item
    assert store.path_ok(item) is True

    deleted = store.delete("临时")
    assert deleted is not None
    assert store.count() == 0


# ---------------------------------------------------------------- 遗忘名单


def test_forgotten_values_roundtrip_and_expiry(tmp_path) -> None:
    _conn, store, _service, _memories = make_env(tmp_path)
    store.add_forgotten("https://a.com/x", now=1_000, ttl_ms=100)
    assert store.is_forgotten_text("我的博客是 https://a.com/x", now=1_050) is True
    # 过期后自动清理
    assert store.is_forgotten_text("我的博客是 https://a.com/x", now=1_200) is False
    # 重新保存同一个值 -> 解除遗忘
    store.add_forgotten("https://a.com/x", now=2_000, ttl_ms=100_000)
    store.clear_forgotten("https://a.com/y")
    store.clear_forgotten("https://a.com/x")
    assert store.is_forgotten_text("https://a.com/x", now=2_001) is False


def test_memory_delete_containing(tmp_path) -> None:
    _conn, _store, _service, memories = make_env(tmp_path)
    memories.add("用户的博客是 https://old.com/x", "fact", 0.7)
    memories.add("用户喜欢拿铁", "preference", 0.5)
    assert memories.delete_containing("https://old.com/x") == 1
    assert len(memories.list_all()) == 1


def test_extractor_skips_forgotten_items(tmp_path) -> None:
    conn, store, _service, memories = make_env(tmp_path)
    profile = ProfileStore(conn)
    extractor = MemoryExtractor(
        memories,
        profile,
        complete=lambda _p: None,  # 本次只测 _apply，不走补全
        prompt="",
        is_forgotten=lambda text: store.is_forgotten_text(text),
    )
    store.add_forgotten("https://old.com/x")
    result = extractor._apply(
        [
            ExtractedMemory(text="用户的博客是 https://old.com/x", kind="fact", importance=0.7),
            ExtractedMemory(text="用户喜欢拿铁", kind="preference", importance=0.5),
        ],
        [],
    )
    assert result.forgotten == 1
    assert [m.text for m in result.added] == ["用户喜欢拿铁"]


# ---------------------------------------------------------------- 服务：保存 / 列表


def test_service_save_batch_summary_and_partial_failure(tmp_path) -> None:
    _conn, _store, service, _memories = make_env(tmp_path)
    result = service.save_from_tool(
        [
            {"name": "博客", "kind": "link", "value": "https://a.com"},
            {"name": "周报", "kind": "link", "value": "https://b.com"},
            {"name": "坏链接", "kind": "link", "value": "ftp://c.com"},
        ]
    )
    assert result["ok"] is True
    assert "记好啦" in result["message"]
    assert "没记成" in result["message"]
    assert service.count() == 2


def test_service_update_purges_old_memory_and_forgets_old_value(tmp_path) -> None:
    _conn, store, service, memories = make_env(tmp_path)
    memories.add("用户的博客是 https://old.com/x", "fact", 0.7)
    service.save_from_tool([{"name": "博客", "kind": "link", "value": "https://old.com/x"}])
    result = service.save_from_tool([{"name": "博客", "kind": "link", "value": "https://new.com/y"}])
    assert result["ok"] is True
    assert memories.list_all() == []
    assert store.is_forgotten_text("https://old.com/x") is True
    # 新值不应被遗忘
    assert store.is_forgotten_text("https://new.com/y") is False


def test_service_list_marks_missing_path(tmp_path) -> None:
    _conn, _store, service, _memories = make_env(tmp_path)
    folder = tmp_path / "会消失的目录"
    folder.mkdir()
    service.save_from_tool([{"name": "旧目录", "kind": "path", "value": str(folder)}])
    folder.rmdir()
    result = service.list_from_tool()
    assert result["ok"] is True
    assert "路径不存在" in result["message"]


# ---------------------------------------------------------------- 服务：打开解析


def test_prepare_open_by_name_and_temp_url(tmp_path) -> None:
    _conn, store, service, _memories = make_env(tmp_path)
    store.save(name="博客", kind="link", value="https://a.com/x")
    ok = service.prepare_open({"name": "博客"}, "打开我的博客")
    assert ok["ok"] is True
    assert ok["args"] == {"kind": "link", "value": "https://a.com/x", "name": "博客"}

    # 临时 URL 必须在本轮消息里
    bad = service.prepare_open({"url": "https://evil.com"}, "打开这个")
    assert bad["ok"] is False and bad["code"] == "url_not_in_message"
    good = service.prepare_open({"url": "https://good.com/a"}, "帮我打开 https://good.com/a")
    assert good["ok"] is True

    text = store.save(name="单号", kind="text", value="SF123").item
    not_openable = service.prepare_open({"name": text.name}, "打开单号")
    assert not_openable["ok"] is False and not_openable["code"] == "item_not_openable"


def test_prepare_open_missing_path(tmp_path) -> None:
    _conn, store, service, _memories = make_env(tmp_path)
    folder = tmp_path / "项目"
    folder.mkdir()
    store.save(name="项目", kind="path", value=str(folder))
    folder.rmdir()
    result = service.prepare_open({"name": "项目"}, "打开项目")
    assert result["ok"] is False
    assert result["code"] == "path_missing"


# ---------------------------------------------------------------- 服务：删文件解析


def test_prepare_delete_path_ambiguity_and_file_intent(tmp_path) -> None:
    _conn, store, service, _memories = make_env(tmp_path)
    folder = tmp_path / "项目"
    folder.mkdir()
    store.save(name="项目", kind="path", value=str(folder))

    ambiguous = service.prepare_delete_path({"name": "项目"}, "删掉项目")
    assert ambiguous["ok"] is False and ambiguous["code"] == "delete_path_ambiguous"

    record = service.prepare_delete_path({"name": "项目"}, "从记忆本删掉项目")
    assert record["ok"] is False and record["code"] == "delete_record_not_file"

    ready = service.prepare_delete_path({"name": "项目"}, "把项目这个文件夹删了")
    assert ready["ok"] is True
    assert ready["args"]["kind"] == "dir"
    assert Path(ready["args"]["path"]).resolve() == folder.resolve()

    # “连文件一起删 + 记录也删”= both：delete_path 成功后本来就会移除记录，放行
    both = service.prepare_delete_path(
        {"name": "项目"}, "把项目这个文件夹删了，记忆本记录也删掉"
    )
    assert both["ok"] is True


def test_prepare_delete_path_saved_name_must_be_mentioned(tmp_path) -> None:
    """路径条目：用户没点名时先问，不凭上下文猜（防文件内容诱导）。"""
    _conn, store, service, _memories = make_env(tmp_path)
    folder = tmp_path / "项目"
    folder.mkdir()
    store.save(name="项目", kind="path", value=str(folder))
    result = service.prepare_delete_path({"name": "项目"}, "把那个文件夹删了")
    assert result["ok"] is False
    assert result["code"] == "item_not_mentioned"


def test_prepare_delete_path_protected_and_ad_hoc(tmp_path) -> None:
    _conn, _store, service, _memories = make_env(tmp_path)
    home = str(Path.home())
    protected = service.prepare_delete_path(
        {"path": home}, f"把 {home} 这个文件夹删了"
    )
    assert protected["ok"] is False and protected["code"] == "path_protected"

    target = tmp_path / "a.txt"
    target.write_text("x", encoding="utf-8")
    ok = service.prepare_delete_path({"path": str(target)}, f"删掉文件 {target}")
    assert ok["ok"] is True
    assert ok["args"]["kind"] == "file"

    # 用户没说过的路径 -> 拒绝（防文件内容诱导）
    not_mentioned = service.prepare_delete_path(
        {"path": str(target)}, "删掉那个文件"
    )
    assert not_mentioned["ok"] is False and not_mentioned["code"] == "path_not_in_message"


# ---------------------------------------------------------------- 服务：删记录


def test_delete_record_requires_name_and_disambiguates_path(tmp_path) -> None:
    _conn, store, service, memories = make_env(tmp_path)
    folder = tmp_path / "项目"
    folder.mkdir()
    store.save(name="博客", kind="link", value="https://a.com")
    store.save(name="项目", kind="path", value=str(folder))

    # 链接：用户点名即可自主删（记录是虚的）
    ok = service.delete_from_tool(["博客"], "忘掉博客")
    assert ok["ok"] is True
    assert service.count() == 1

    # 路径：只说“删掉” -> 反问，不删
    ambiguous = service.delete_from_tool(["项目"], "删掉项目")
    assert ambiguous["ok"] is False
    assert "只删记忆本记录" in ambiguous["message"]
    assert service.count() == 1

    # 明确“从记忆本删掉” -> 只删记录
    record = service.delete_from_tool(["项目"], "从记忆本删掉项目")
    assert record["ok"] is True
    assert service.count() == 0

    # 删除时清理记忆并写入遗忘名单
    memories.add("项目在 D 盘", "fact", 0.5)
    store.save(name="项目2", kind="path", value=str(folder))
    service.delete_from_tool(["项目2"], "忘掉项目2的记录")
    assert store.is_forgotten_text(str(folder)) is True


def test_delete_record_requires_user_mention(tmp_path) -> None:
    _conn, store, service, _memories = make_env(tmp_path)
    store.save(name="博客", kind="link", value="https://a.com")
    result = service.delete_from_tool(["博客"], "把那个删了")
    assert result["ok"] is False
    assert "点名" in result["message"]
    assert service.count() == 1

    # 设置页 trust=True：用户亲手点删，无需原话点名
    trusted = service.delete_from_tool(["博客"], trust=True)
    assert trusted["ok"] is True
    assert service.count() == 0


def test_forget_by_path_removes_record_and_purges_memory(tmp_path) -> None:
    _conn, store, service, memories = make_env(tmp_path)
    folder = tmp_path / "项目"
    folder.mkdir()
    store.save(name="项目", kind="path", value=str(folder))
    memories.add(f"用户的项目在 {folder}", "fact", 0.7)
    result = service.forget_by_path(str(folder))
    assert result["ok"] is True
    assert service.count() == 0
    assert memories.list_all() == []
    assert store.is_forgotten_text(str(folder)) is True


# ---------------------------------------------------------------- 注入格式


def test_notebook_block_hides_links_and_paths_but_shows_text(tmp_path) -> None:
    _conn, store, _service, _memories = make_env(tmp_path)
    folder = tmp_path / "项目"
    folder.mkdir()
    store.save(name="博客", kind="link", value="https://secret.example.com/x")
    store.save(name="项目", kind="path", value=str(folder))
    store.save(name="单号", kind="text", value="SF123456789")
    block = build_notebook_block(store.list_all())
    assert block is not None
    assert "博客（链接）" in block
    assert "项目（文件夹）" in block
    assert "secret.example.com" not in block
    assert str(folder) not in block
    assert "SF123456789" in block
