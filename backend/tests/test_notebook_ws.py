"""记忆本 WS 链路测试（2026-10-18）：设置页 CRUD + 宠物面“文件已删”回传。

用轻量 ConnectionContext 替身 + 真 Dispatcher 验证：
- notebook_* handler 只在装配了 notebook 服务时注册；
- list / save / rename / delete 的回执与列表刷新；
- notebook_file_deleted 移除对应路径记录；
- 未装配时走 NOT_IMPLEMENTED 兜底。
"""

from __future__ import annotations

import asyncio
import json
import uuid
from pathlib import Path
from typing import Any

import pytest

from backend.application.chat_pipeline import ChatPipeline
from backend.application.notebook_service import NotebookService
from backend.application.session import SessionManager
from backend.interfaces.ws.dispatcher import build_dispatcher
from backend.interfaces.ws.protocol import parse_client_message
from backend.modules.notebook import NotebookStore
from backend.shared.db import connect_db
from fakes import EchoLLMProvider


class FakeCtx:
    def __init__(self) -> None:
        self.id = "c_test"
        self.authed = True
        self.session_id = "s_test"
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


def make_dispatcher(tmp_path: Path, *, with_notebook: bool):
    service = None
    if with_notebook:
        conn = connect_db(tmp_path / "pet.db")
        service = NotebookService(NotebookStore(conn))
    dispatcher = build_dispatcher(
        pipeline=ChatPipeline(provider=EchoLLMProvider()),
        sessions=SessionManager(),
        token="t",
        app_version="test",
        notebook=service,
    )
    return dispatcher, service


def raw(msg_type: str, data: dict) -> str:
    return json.dumps(
        {"v": 1, "id": f"t_{uuid.uuid4().hex[:8]}", "type": msg_type, "ts": 0, "data": data}
    )


async def dispatch(dispatcher, ctx: FakeCtx, msg_type: str, data: dict) -> None:
    await dispatcher.dispatch(ctx, parse_client_message(raw(msg_type, data)))


def test_notebook_handlers_registered_only_when_configured(tmp_path) -> None:
    with_nb, _ = make_dispatcher(tmp_path, with_notebook=True)
    for event in (
        "notebook_list",
        "notebook_save",
        "notebook_rename",
        "notebook_delete",
        "notebook_file_deleted",
    ):
        assert with_nb.has(event)

    without, _ = make_dispatcher(tmp_path, with_notebook=False)
    assert not without.has("notebook_list")


def test_notebook_crud_roundtrip(tmp_path) -> None:
    dispatcher, service = make_dispatcher(tmp_path, with_notebook=True)
    assert service is not None

    async def scenario() -> None:
        ctx = FakeCtx()
        await dispatch(dispatcher, ctx, "notebook_save", {
            "items": [{"name": "博客", "kind": "link", "value": "https://a.com"}]
        })
        results = [d for t, d in ctx.sent if t == "notebook_result"]
        assert results and results[-1]["ok"] is True
        items_event = [d for t, d in ctx.sent if t == "notebook_items"]
        assert items_event[-1]["count"] == 1
        assert items_event[-1]["items"][0]["name"] == "博客"

        ctx.sent.clear()
        await dispatch(dispatcher, ctx, "notebook_rename", {
            "old_name": "博客", "new_name": "主页"
        })
        items_event = [d for t, d in ctx.sent if t == "notebook_items"]
        assert items_event[-1]["items"][0]["name"] == "主页"

        ctx.sent.clear()
        await dispatch(dispatcher, ctx, "notebook_delete", {"names": ["主页"]})
        items_event = [d for t, d in ctx.sent if t == "notebook_items"]
        assert items_event[-1]["count"] == 0

    asyncio.run(scenario())


def test_notebook_list_returns_path_status(tmp_path) -> None:
    dispatcher, service = make_dispatcher(tmp_path, with_notebook=True)
    assert service is not None
    folder = tmp_path / "项目"
    folder.mkdir()
    service.save_from_tool([{"name": "项目", "kind": "path", "value": str(folder)}])
    folder.rmdir()

    async def scenario() -> None:
        ctx = FakeCtx()
        await dispatch(dispatcher, ctx, "notebook_list", {"kind": "path"})
        items = [d for t, d in ctx.sent if t == "notebook_items"][-1]
        assert items["items"][0]["path_exists"] is False

    asyncio.run(scenario())


def test_notebook_file_deleted_removes_record(tmp_path) -> None:
    dispatcher, service = make_dispatcher(tmp_path, with_notebook=True)
    assert service is not None
    folder = tmp_path / "项目"
    folder.mkdir()
    service.save_from_tool([{"name": "项目", "kind": "path", "value": str(folder)}])

    async def scenario() -> None:
        ctx = FakeCtx()
        await dispatch(dispatcher, ctx, "notebook_file_deleted", {"path": str(folder)})
        assert service.count() == 0
        assert any(t == "notebook_result" and d.get("ok") for t, d in ctx.sent)

    asyncio.run(scenario())


def test_notebook_falls_back_to_not_implemented_without_service(tmp_path) -> None:
    dispatcher, _ = make_dispatcher(tmp_path, with_notebook=False)

    async def scenario() -> None:
        ctx = FakeCtx()
        await dispatch(dispatcher, ctx, "notebook_list", {})
        assert ctx.errors and ctx.errors[0][0] == "NOT_IMPLEMENTED"

    asyncio.run(scenario())
