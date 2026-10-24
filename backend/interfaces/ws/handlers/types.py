"""WS 事件处理器的共享类型。"""

from __future__ import annotations

from typing import TYPE_CHECKING, Awaitable, Callable, Protocol

if TYPE_CHECKING:
    from backend.interfaces.ws.protocol import ClientMessage
    from backend.interfaces.ws.server import ConnectionContext


Handler = Callable[["ConnectionContext", "ClientMessage"], Awaitable[None]]


class HandlerRegistry(Protocol):
    """处理器注册入口（Dispatcher 的结构化子集，避免 handlers 反向依赖 dispatcher）。"""

    def register(self, msg_type: str, handler: Handler) -> None: ...
