"""用户画像摘要（2026-10-18 启动称呼引导；未装配画像时不注册）。"""

from __future__ import annotations

from typing import TYPE_CHECKING, Callable

from loguru import logger

from backend.interfaces.ws.handlers.types import HandlerRegistry

if TYPE_CHECKING:  # 避免与 server 运行时循环 import（类型注解专用）
    from backend.interfaces.ws.protocol import ClientMessage
    from backend.interfaces.ws.server import ConnectionContext
    from backend.modules.memory.profile import ProfileStore

#: 画像里可能存放"用户称呼"的 key（记忆提取 prompt 建议 称呼/姓名；昵称/用户名兜底）
_USER_NAME_PROFILE_KEYS = ("称呼", "姓名", "昵称", "用户名")


def register_profile_handlers(
    registry: HandlerRegistry,
    *,
    profile: ProfileStore | None = None,
    memory_enabled: Callable[[], bool] | None = None,
) -> None:
    """注册画像摘要处理器；未装配画像存储时跳过。"""
    if profile is None:
        return

    async def on_get_profile(ctx: ConnectionContext, msg: ClientMessage) -> None:
        """拉取用户画像摘要（启动称呼引导）：只回是否有名字 + 名字 + 记忆开关。

        名字按「称呼 → 姓名 → 昵称 → 用户名」取第一个非空值——记忆提取 prompt
        可能写成其中任意一个 key；其余画像条目（城市/职业等）不对外暴露。
        """
        assert profile is not None
        name: str | None = None
        for key in _USER_NAME_PROFILE_KEYS:
            try:
                value = profile.get(key)
            except Exception:
                logger.exception("画像读取失败（get_profile，key={}）", key)
                continue
            if value and value.strip():
                name = value.strip()
                break
        enabled = True
        if memory_enabled is not None:
            try:
                enabled = bool(memory_enabled())
            except Exception:
                logger.exception("读取记忆提取开关失败（按开启返回）")
        await ctx.send_event(
            "profile",
            {"has_name": name is not None, "name": name, "memory_enabled": enabled},
            reply_to=msg.envelope.id,
        )

    registry.register("get_profile", on_get_profile)
