"""对话流水线对外类型：单轮选项与出站端口。"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Protocol


@dataclass(frozen=True)
class TurnOptions:
    """单轮对话选项（工作模式 / 教学模式，2026-10-18）。

    - ``search``：是否向模型提供联网工具（False 时移除 web_search / web_fetch）；
    - ``teaching``：教学模式中追加"老师口吻、分章节讲解"的临时提示（不落库、不进历史）。

    定义在 application 层（而不是 import interfaces 的协议模型），保持
    "interfaces 依赖 application、application 不反向依赖"的依赖方向。
    """

    search: bool = True
    teaching: bool = False


class ReplySink(Protocol):
    """对话流水线的出站端口（依赖倒置：由 interfaces 层实现为 WS 事件）。"""

    async def state(self, state: str) -> None: ...

    async def reply_start(self, message_id: str) -> None: ...

    async def message_saved(self, client_id: str, db_id: int, role: str) -> None:
        """一条消息已落库：把 DB 行 id 回给前端（工作模式单条删除用）。"""
        ...

    async def reasoning(self, message_id: str, text: str) -> None:
        """推理模型思考过程增量（工作模式折叠展示；不进入正文/TTS）。"""
        ...

    async def token(self, message_id: str, text: str) -> None: ...

    async def sentence(self, message_id: str, index: int, text: str) -> None: ...

    async def emotion(self, message_id: str, emotion: str, intensity: float) -> None: ...

    async def reply_end(
        self, message_id: str, full_text: str, *, interrupted: bool = False
    ) -> None: ...

    async def tool_call(self, tool_id: str, name: str, args: dict) -> None:
        """本轮模型请求的工具调用（§4.7）：前端执行（如 open_settings → 开设置窗）。"""
        ...

    async def error(self, code: str, message: str) -> None: ...

    async def send_binary(self, frame: bytes) -> None: ...

    async def notice(self, code: str, message: str, level: str = "info") -> None:
        """一次性提示（文件分析丢弃旧上下文等）；不进入回复正文/历史/TTS。"""
        ...

    async def sources(self, message_id: str, items: list[dict[str, Any]]) -> None:
        """本轮联网搜索的结构化来源（工作窗引用悬浮卡片用）。"""
        ...
