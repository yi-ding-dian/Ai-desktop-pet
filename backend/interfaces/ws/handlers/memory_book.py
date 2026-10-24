"""设置页记忆本与删文件回调（2026-10-18；未装配记忆本服务时不注册）。"""

from __future__ import annotations

from typing import TYPE_CHECKING, cast

from backend.interfaces.ws.handlers.types import HandlerRegistry
from backend.interfaces.ws.protocol import (
    MemoryBookDeleteData,
    MemoryBookFileDeletedData,
    MemoryBookListData,
    MemoryBookRenameData,
    MemoryBookSaveData,
)
from backend.modules.memory_book import KINDS

if TYPE_CHECKING:  # 避免与 server 运行时循环 import（类型注解专用）
    from backend.application.memory_book_service import MemoryBookService
    from backend.interfaces.ws.protocol import ClientMessage
    from backend.interfaces.ws.server import ConnectionContext


def register_memory_book_handlers(
    registry: HandlerRegistry, *, memory_book: MemoryBookService | None = None
) -> None:
    """注册记忆本处理器；未装配记忆本服务时整组跳过。"""
    if memory_book is None:
        return

    async def on_memory_book_list(ctx: ConnectionContext, msg: ClientMessage) -> None:
        """设置页：拉取记忆本快照（可按类型过滤）。"""
        assert memory_book is not None
        data = cast(MemoryBookListData, msg.data)
        kind = data.kind if data.kind in KINDS else None
        await ctx.send_event(
            "memory_book_items", memory_book.snapshot(kind), reply_to=msg.envelope.id
        )

    async def on_memory_book_save(ctx: ConnectionContext, msg: ClientMessage) -> None:
        """设置页：保存/同名更新，回结果 + 最新快照。"""
        assert memory_book is not None
        data = cast(MemoryBookSaveData, msg.data)
        result = memory_book.save_from_tool(
            [item.model_dump() for item in data.items],
            allow_program=ctx.client_role == "settings",
        )
        await ctx.send_event("memory_book_result", result, reply_to=msg.envelope.id)
        if result.get("ok"):
            await ctx.send_event(
                "memory_book_items", memory_book.snapshot(), reply_to=msg.envelope.id
            )

    async def on_memory_book_rename(ctx: ConnectionContext, msg: ClientMessage) -> None:
        """设置页：改名；成功回最新快照。"""
        assert memory_book is not None
        data = cast(MemoryBookRenameData, msg.data)
        result = memory_book.rename_from_tool(data.old_name, data.new_name)
        await ctx.send_event("memory_book_result", result, reply_to=msg.envelope.id)
        if result.get("ok"):
            await ctx.send_event(
                "memory_book_items", memory_book.snapshot(), reply_to=msg.envelope.id
            )

    async def on_memory_book_delete(ctx: ConnectionContext, msg: ClientMessage) -> None:
        """设置页：删除记录（按钮即明确操作，trust=True 跳过"点名"保护）。"""
        assert memory_book is not None
        data = cast(MemoryBookDeleteData, msg.data)
        result = memory_book.delete_from_tool(data.names, trust=True)
        await ctx.send_event("memory_book_result", result, reply_to=msg.envelope.id)
        if result.get("ok"):
            await ctx.send_event(
                "memory_book_items", memory_book.snapshot(), reply_to=msg.envelope.id
            )

    async def on_memory_book_file_deleted(
        ctx: ConnectionContext, msg: ClientMessage
    ) -> None:
        """宠物面：主进程已确认删除真实文件——移除记忆本记录并清理长期记忆。"""
        assert memory_book is not None
        data = cast(MemoryBookFileDeletedData, msg.data)
        result = memory_book.forget_by_path(data.path)
        await ctx.send_event("memory_book_result", result, reply_to=msg.envelope.id)
        if result.get("ok"):
            await ctx.send_event(
                "memory_book_items", memory_book.snapshot(), reply_to=msg.envelope.id
            )

    registry.register("memory_book_list", on_memory_book_list)
    registry.register("memory_book_save", on_memory_book_save)
    registry.register("memory_book_rename", on_memory_book_rename)
    registry.register("memory_book_delete", on_memory_book_delete)
    registry.register("memory_book_file_deleted", on_memory_book_file_deleted)
