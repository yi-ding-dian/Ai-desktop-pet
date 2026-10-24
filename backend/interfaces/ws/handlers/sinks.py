"""把 ConnectionContext 适配成下层端口的出站 sink（interfaces 层职责）。"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from loguru import logger
from starlette.websockets import WebSocketState

if TYPE_CHECKING:  # 避免与 server 运行时循环 import（类型注解专用）
    from backend.application.reminder_service import ReminderDelivery
    from backend.interfaces.ws.server import ConnectionContext


class _ConnectionSink:
    """把 ConnectionContext 适配为行为引擎的 BehaviorSink（interfaces 层职责）。

    引擎在 modules 层，不感知 WS 细节；连接存活检测依据 starlette WebSocket 的
    client_state（消息循环收到 disconnect 后即变为 DISCONNECTED）。
    """

    def __init__(self, ctx: ConnectionContext) -> None:
        self._ctx = ctx

    async def send_event(
        self, msg_type: str, data: Any = None, *, reply_to: str | None = None
    ) -> bool:
        if self.is_closed():
            return False
        await self._ctx.send_event(msg_type, data, reply_to=reply_to)
        return True

    def is_closed(self) -> bool:
        ws = getattr(self._ctx, "ws", None)
        state = getattr(ws, "client_state", None)
        # 拿不到状态时保守视为未关闭（真实发送失败由 server 层日志兜底）
        return state is not None and state != WebSocketState.CONNECTED


class _ReminderSink:
    """把 ConnectionContext 适配为提醒服务的下行端口（interfaces 层职责）。

    提醒的下行是"主动消息"：先推 ``proactive``（**气泡一定会出**，与语音开关无关），
    再按 delivery.voice 决定是否合成语音帧。语音失败只降级为无声，不影响提醒送达。
    """

    def __init__(self, ctx: ConnectionContext) -> None:
        self._ctx = ctx

    def is_closed(self) -> bool:
        ws = getattr(self._ctx, "ws", None)
        state = getattr(ws, "client_state", None)
        return state is not None and state != WebSocketState.CONNECTED

    async def deliver(self, delivery: ReminderDelivery) -> bool:
        if self.is_closed():
            return False
        first = delivery.items[0] if delivery.items else None
        await self._ctx.send_event(
            "proactive",
            {
                "message_id": delivery.message_id,
                "text": delivery.text,
                "emotion": delivery.emotion,
                "kind": "reminder",
                "batch_id": delivery.batch_id,
                "items": [
                    {
                        "id": item.event_id,
                        "reminder_id": item.reminder_id,
                        "text": item.text,
                        "due_at": item.due_at,
                        "late": item.late,
                    }
                    for item in delivery.items
                ],
                # 兼容旧字段：批次第一项
                "reminder_id": first.reminder_id if first else None,
                "due_at": first.due_at if first else None,
                "late": delivery.late,
            },
        )
        if delivery.voice:
            await self._speak(delivery)
        return True

    async def _speak(self, delivery: ReminderDelivery) -> None:
        """可选语音通道：TTS 未启用/失败都只记日志，气泡已经送达。"""
        voice = getattr(self._ctx, "voice", None)
        if voice is None or not getattr(voice, "available", False):
            return
        try:
            reply = voice.open_reply(self._ctx, delivery.message_id)
            reply.push(0, delivery.spoken_text)
            reply.mark_final(0)
            await reply.finish()
        except Exception:
            logger.exception("提醒语音播报失败（气泡不受影响）")
