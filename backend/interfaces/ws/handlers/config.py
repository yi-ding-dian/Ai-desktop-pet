"""设置面板：配置快照、更新与测试连接（§7.6；未装配设置服务时不注册）。"""

from __future__ import annotations

from typing import TYPE_CHECKING, cast

from backend.application.settings_service import ConfigInvalid, SettingsService
from backend.interfaces.ws.handlers.types import HandlerRegistry
from backend.interfaces.ws.protocol import SetConfigData, TestLlmData
from backend.shared.errors import ErrorCode

if TYPE_CHECKING:  # 避免与 server 运行时循环 import（类型注解专用）
    from backend.interfaces.ws.protocol import ClientMessage
    from backend.interfaces.ws.server import ConnectionContext


def register_config_handlers(
    registry: HandlerRegistry, *, settings: SettingsService | None = None
) -> None:
    """注册设置面板处理器；未装配设置服务时整组跳过（走 NOT_IMPLEMENTED）。"""
    if settings is None:
        return

    async def on_get_config(ctx: ConnectionContext, msg: ClientMessage) -> None:
        """拉取配置快照（§3.2 get_config → §3.3 config）：key 以掩码返回，绝不回明文。"""
        assert settings is not None
        await ctx.send_event("config", settings.snapshot(), reply_to=msg.envelope.id)

    async def on_set_config(ctx: ConnectionContext, msg: ClientMessage) -> None:
        """更新配置（§7.6.3）：校验 → key 入 keyring + 写回 toml → 热重装配 → config 回执。

        - 字段校验失败：error{code:"CONFIG_INVALID", message:具体原因}，不改任何状态；
        - 成功：推 `config`（新快照）作回执，reply_to 配对请求。
        """
        assert settings is not None
        data = cast(SetConfigData, msg.data)
        try:
            snapshot = await settings.apply_patch(data.patch)
        except ConfigInvalid as exc:
            await ctx.send_error(
                ErrorCode.CONFIG_INVALID, exc.message, reply_to=msg.envelope.id
            )
            return
        await ctx.send_event("config", snapshot, reply_to=msg.envelope.id)

    async def on_test_llm(ctx: ConnectionContext, msg: ClientMessage) -> None:
        """测试连接（§3.2 test_llm → §3.3 llm_test_result）：

        最小 chat 请求验证鉴权与地址 + 尽力拉 /models；失败 message 说明具体原因。
        """
        assert settings is not None
        data = cast(TestLlmData, msg.data)
        payload = await settings.test_llm(
            base_url=data.base_url, model=data.model, key=data.key
        )
        await ctx.send_event("llm_test_result", payload, reply_to=msg.envelope.id)

    registry.register("get_config", on_get_config)
    registry.register("set_config", on_set_config)
    registry.register("test_llm", on_test_llm)
