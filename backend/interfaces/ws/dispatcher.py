"""消息类型 → 用例的路由注册表（设计文档 §2.3 dispatcher）。

原则：协议内但未实现的事件类型，统一回 ``error{code:"NOT_IMPLEMENTED"}``，
禁止静默丢弃。

处理器按业务域放在 ``handlers/``；本文件只保留路由表、分发逻辑与装配入口。
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Callable

from loguru import logger

from backend.application.chat_pipeline import ChatPipeline
from backend.application.session import SessionManager
from backend.application.settings_service import SettingsService
from backend.interfaces.ws.handlers import (
    register_chat_handlers,
    register_config_handlers,
    register_memory_book_handlers,
    register_pet_handlers,
    register_profile_handlers,
    register_reminder_handlers,
)
from backend.interfaces.ws.handlers.types import Handler
from backend.interfaces.ws.protocol import ClientMessage
from backend.shared.errors import ErrorCode, ProtocolError

if TYPE_CHECKING:  # 避免与 server 运行时循环 import（类型注解专用）
    from backend.application.memory_book_service import MemoryBookService
    from backend.application.reminder_service import ReminderService
    from backend.interfaces.ws.server import ConnectionContext
    from backend.modules.behavior.engine import BehaviorEngine
    from backend.modules.chat.history import HistoryStore
    from backend.modules.memory.profile import ProfileStore


class Dispatcher:
    """事件路由表：按信封 type 分发到 handler。"""

    def __init__(self) -> None:
        self._handlers: dict[str, Handler] = {}

    def register(self, msg_type: str, handler: Handler) -> None:
        if msg_type in self._handlers:
            raise ValueError(f"事件类型重复注册：{msg_type}")
        self._handlers[msg_type] = handler

    def has(self, msg_type: str) -> bool:
        """是否已注册该类型的 handler。"""
        return msg_type in self._handlers

    async def dispatch(self, ctx: ConnectionContext, msg: ClientMessage) -> None:
        """分发一条消息；未注册类型回 NOT_IMPLEMENTED。"""
        handler = self._handlers.get(msg.envelope.type)
        if handler is None:
            await ctx.send_error(
                ErrorCode.NOT_IMPLEMENTED,
                f"事件类型 {msg.envelope.type} 尚未实现",
                reply_to=msg.envelope.id,
            )
            return
        try:
            await handler(ctx, msg)
        except ProtocolError as exc:
            await ctx.send_error(
                exc.code, exc.message, fatal=exc.fatal, reply_to=msg.envelope.id
            )
            if exc.fatal:
                ctx.request_close(1002, "protocol error")
        except Exception:
            logger.exception("处理事件 {} 时发生未预期异常", msg.envelope.type)
            await ctx.send_error(
                ErrorCode.INTERNAL, "服务端内部错误", reply_to=msg.envelope.id
            )


def build_dispatcher(
    *,
    pipeline: ChatPipeline,
    sessions: SessionManager,
    token: str,
    app_version: str,
    engine: BehaviorEngine | None = None,
    history: HistoryStore | None = None,
    settings: SettingsService | None = None,
    reminders: ReminderService | None = None,
    memory_book: MemoryBookService | None = None,
    profile: ProfileStore | None = None,
    memory_enabled: Callable[[], bool] | None = None,
) -> Dispatcher:
    """装配默认事件路由（interfaces → application 的唯一接线点）。

    ``engine``：自主行为引擎（Phase 3，可为 None——未装配时 pet_event /
    behavior_done / env_update 走惰性兜底分支，不阻断其余事件）。
    ``history``：会话历史库（P3，可为 None——load_history 退化为空历史回填）。
    ``settings``：设置面板用例（§7.6，可为 None——未装配时 get_config /
    set_config / test_llm 走 NOT_IMPLEMENTED 兜底，与旧版行为一致）。
    ``reminders``：提醒调度服务（2026-10-18，可为 None——未装配存储时无提醒功能）。
    ``memory_book``：记忆本服务（2026-10-18，可为 None——未装配时设置页记忆本请求
    与 ``memory_book_file_deleted`` 均走 NOT_IMPLEMENTED；工具也不会注册）。
    ``profile``：用户画像存储（2026-10-18 启动称呼引导，可为 None——未装配时
    get_profile 走 NOT_IMPLEMENTED；前端静默跳过称呼引导）。
    ``memory_enabled``：后台记忆提取开关的活引用（get_profile 回给前端，用于判断
    "问了名字也存不上"时是否跳过引导）。
    """
    dispatcher = Dispatcher()
    register_chat_handlers(
        dispatcher,
        pipeline=pipeline,
        sessions=sessions,
        token=token,
        app_version=app_version,
        engine=engine,
        history=history,
        reminders=reminders,
    )
    register_pet_handlers(dispatcher, engine=engine)
    register_reminder_handlers(dispatcher, reminders=reminders)
    register_config_handlers(dispatcher, settings=settings)
    register_memory_book_handlers(dispatcher, memory_book=memory_book)
    register_profile_handlers(
        dispatcher, profile=profile, memory_enabled=memory_enabled
    )
    return dispatcher
