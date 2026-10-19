"""记忆本 WS 链路测试（2026-10-18）：设置页 CRUD + 宠物面“文件已删”回传。

用轻量 ConnectionContext 替身 + 真 Dispatcher 验证：
- memory_book_* handler 只在装配了 memory_book 服务时注册；
- list / save / rename / delete 的回执与列表刷新；
- memory_book_file_deleted 移除对应路径记录；
- 未装配时走 NOT_IMPLEMENTED 兜底。
"""

from __future__ import annotations

import asyncio
import json
import os
import uuid
from pathlib import Path
from typing import Any

import pytest

from backend.application.chat_pipeline import ChatPipeline
from backend.application.memory_book_service import MemoryBookService
from backend.application.session import SessionManager
from backend.interfaces.ws.dispatcher import build_dispatcher
from backend.interfaces.ws.protocol import parse_client_message
from backend.modules.memory_book import MemoryBookStore
from backend.shared.db import connect_db
from fakes import EchoLLMProvider


class FakeCtx:
    def __init__(self) -> None:
        self.id = "c_test"
        self.authed = True
        self.session_id = "s_test"
        self.client_role = "pet"
        self.close_request: tuple[int, str] | None = None
        self.sent: list[tuple[str, dict[str, Any]]] = []
        self.errors: list[tuple[str, str]] = []

    async def send_event(
        self, msg_type: str, data: Any = None, *, reply_to: str | None = None
    ) -> None:
        self.sent.append((msg_type, data or {}))

    async def send_error(
        self, code: Any, message: str, *, fatal: bool = False, reply_to: str | None = None
    ) -> None:
        self.errors.append((str(code), message))

    def request_close(self, code: int, reason: str = "") -> None:
        self.close_request = (code, reason)


def make_dispatcher(tmp_path: Path, *, with_memory_book: bool):
    service = None
    if with_memory_book:
        conn = connect_db(tmp_path / "pet.db")
        service = MemoryBookService(MemoryBookStore(conn))
    dispatcher = build_dispatcher(
        pipeline=ChatPipeline(provider=EchoLLMProvider()),
        sessions=SessionManager(),
        token="t",
        app_version="test",
        memory_book=service,
    )
    return dispatcher, service


def raw(msg_type: str, data: dict) -> str:
    return json.dumps(
        {"v": 1, "id": f"t_{uuid.uuid4().hex[:8]}", "type": msg_type, "ts": 0, "data": data}
    )


async def dispatch(dispatcher, ctx: FakeCtx, msg_type: str, data: dict) -> None:
    await dispatcher.dispatch(ctx, parse_client_message(raw(msg_type, data)))


def test_memory_book_handlers_registered_only_when_configured(tmp_path) -> None:
    with_nb, _ = make_dispatcher(tmp_path, with_memory_book=True)
    for event in (
        "memory_book_list",
        "memory_book_save",
        "memory_book_rename",
        "memory_book_delete",
        "memory_book_file_deleted",
    ):
        assert with_nb.has(event)

    without, _ = make_dispatcher(tmp_path, with_memory_book=False)
    assert not without.has("memory_book_list")


def test_memory_book_crud_roundtrip(tmp_path) -> None:
    dispatcher, service = make_dispatcher(tmp_path, with_memory_book=True)
    assert service is not None

    async def scenario() -> None:
        ctx = FakeCtx()
        await dispatch(dispatcher, ctx, "memory_book_save", {
            "items": [{"name": "博客", "kind": "link", "value": "https://a.com"}]
        })
        results = [d for t, d in ctx.sent if t == "memory_book_result"]
        assert results and results[-1]["ok"] is True
        items_event = [d for t, d in ctx.sent if t == "memory_book_items"]
        assert items_event[-1]["count"] == 1
        assert items_event[-1]["items"][0]["name"] == "博客"

        ctx.sent.clear()
        await dispatch(dispatcher, ctx, "memory_book_rename", {
            "old_name": "博客", "new_name": "主页"
        })
        items_event = [d for t, d in ctx.sent if t == "memory_book_items"]
        assert items_event[-1]["items"][0]["name"] == "主页"

        ctx.sent.clear()
        await dispatch(dispatcher, ctx, "memory_book_delete", {"names": ["主页"]})
        items_event = [d for t, d in ctx.sent if t == "memory_book_items"]
        assert items_event[-1]["count"] == 0

    asyncio.run(scenario())


def test_memory_book_list_returns_path_status(tmp_path) -> None:
    dispatcher, service = make_dispatcher(tmp_path, with_memory_book=True)
    assert service is not None
    folder = tmp_path / "项目"
    folder.mkdir()
    service.save_from_tool([{"name": "项目", "kind": "path", "value": str(folder)}])
    folder.rmdir()

    async def scenario() -> None:
        ctx = FakeCtx()
        await dispatch(dispatcher, ctx, "memory_book_list", {"kind": "path"})
        items = [d for t, d in ctx.sent if t == "memory_book_items"][-1]
        assert items["items"][0]["path_exists"] is False

    asyncio.run(scenario())


def test_memory_book_file_deleted_removes_record(tmp_path) -> None:
    dispatcher, service = make_dispatcher(tmp_path, with_memory_book=True)
    assert service is not None
    folder = tmp_path / "项目"
    folder.mkdir()
    service.save_from_tool([{"name": "项目", "kind": "path", "value": str(folder)}])

    async def scenario() -> None:
        ctx = FakeCtx()
        await dispatch(dispatcher, ctx, "memory_book_file_deleted", {"path": str(folder)})
        assert service.count() == 0
        assert any(t == "memory_book_result" and d.get("ok") for t, d in ctx.sent)

    asyncio.run(scenario())


def test_memory_book_falls_back_to_not_implemented_without_service(tmp_path) -> None:
    dispatcher, _ = make_dispatcher(tmp_path, with_memory_book=False)

    async def scenario() -> None:
        ctx = FakeCtx()
        await dispatch(dispatcher, ctx, "memory_book_list", {})
        assert ctx.errors and ctx.errors[0][0] == "NOT_IMPLEMENTED"

    asyncio.run(scenario())


@pytest.mark.skipif(os.name == "nt", reason="POSIX 执行位语义")
def test_program_entries_only_savable_from_settings_role(tmp_path) -> None:
    """program 只能由设置页连接创建；宠物窗/模型工具路径一律拒绝（2026-10-19）。"""
    dispatcher, service = make_dispatcher(tmp_path, with_memory_book=True)
    assert service is not None
    exe = tmp_path / "app"
    exe.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
    exe.chmod(0o755)

    async def scenario() -> None:
        pet = FakeCtx()  # client_role 默认 pet
        await dispatch(dispatcher, pet, "memory_book_save", {
            "items": [{"name": "程序", "kind": "program", "value": str(exe)}]
        })
        pet_result = [d for t, d in pet.sent if t == "memory_book_result"][-1]
        assert pet_result["ok"] is False
        assert "设置" in pet_result["message"]
        assert service.count() == 0

        settings = FakeCtx()
        settings.client_role = "settings"
        await dispatch(dispatcher, settings, "memory_book_save", {
            "items": [{"name": "程序", "kind": "program", "value": str(exe)}]
        })
        settings_result = [d for t, d in settings.sent if t == "memory_book_result"][-1]
        assert settings_result["ok"] is True
        assert service.count() == 1

        # kind=program 的列表过滤不再被白名单丢弃
        settings.sent.clear()
        await dispatch(dispatcher, settings, "memory_book_list", {"kind": "program"})
        items = [d for t, d in settings.sent if t == "memory_book_items"][-1]
        assert items["count"] == 1
        assert items["items"][0]["kind"] == "program"
        assert items["items"][0]["path_exists"] is True

    asyncio.run(scenario())
