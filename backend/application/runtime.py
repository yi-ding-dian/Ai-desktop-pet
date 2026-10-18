"""运行时可重装配控制面（设计文档 §7.6.3 后端热重装配）。

设置面板保存配置（``set_config``）后，用例层调这里把新配置分派到受影响模块，
**保存即生效**（无需重启后端）。结构：

- ``LlmSlot`` / ``TtsSlot``：**热替换引用**——对话流水线 / 记忆提取 / 设置面板
  "测试连接"统一持有槽，换 provider 后所有持有者下一个请求即用新配置；
  LLM key 不进槽（provider 每次请求经 shared.secrets 读取链惰性取，
  keyring 更新天然即时生效）；
- ``Runtime``：持有当前配置与各模块活引用（main 装配），提供 ``apply(config)``
  分派与 ``voice_factory``（每条连接语音出站的装配点）；内置工具注册表
  （§4.7，``build_default_registry``）同样在此装配——进程内只读、随 Runtime
  生命周期存活（本期无热更需求）。

能热更 / 不能热更的边界（§7.6.3 要求明确）：
- llm：base_url / model / temperature / max_tokens 热更（重建 provider）；
- voice：enabled / provider / voice 热更（重建 TTS provider + VoiceOut 动态开关）；
- behavior：enabled / 空闲间隔 / 免打扰 热更（引擎每轮动态读）；
  ``proactive_enabled`` / ``greeting`` 尚无消费点（主动对话未实现，配置已存）；
- memory：enabled / 空闲阈值 / 扫描周期 热更（服务循环每轮动态读）；
- reminders：enabled 联动启停，语音/补报上限/免打扰策略每 tick 动态读；
- 无"重启后生效"的残留项（主题等前端侧配置不走后端，见 §7.6.4）。

依赖方向：application 层——依赖 modules（llm/voice/reminders）与 shared；不 import
interfaces（WS 细节由 dispatcher 转换）。
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any, AsyncIterator, Sequence

from loguru import logger

from backend.application.reminder_service import ReminderService
from backend.application.voice import VoiceOut
from backend.modules.llm.openai_compat import OpenAICompatProvider
from backend.modules.llm.provider import ChatMessage, Chunk, LLMProvider, ProbeResult
from backend.modules.reminders import ReminderStore
from backend.modules.tools import ToolRegistry, build_default_registry
from backend.modules.voice.tts import TTSProvider, create_tts_provider
from backend.shared.config import AppConfig
from backend.shared.errors import TtsError, TtsErrorCode
from backend.shared.secrets import get_llm_key

if TYPE_CHECKING:  # 仅类型注解（运行时经鸭子类型调用，避免多余 import 环）
    from backend.application.memory_service import MemoryService
    from backend.application.notebook_service import NotebookService
    from backend.modules.behavior.engine import BehaviorEngine


def create_llm_provider(config: AppConfig) -> OpenAICompatProvider:
    """按配置构造 LLM provider（key 不在构造期解析——经读取链惰性获取）。"""
    return OpenAICompatProvider(
        base_url=config.llm.base_url,
        model=config.llm.model,
        temperature=config.llm.temperature,
        max_tokens=config.llm.max_tokens,
        key_provider=get_llm_key,
    )


class LlmSlot:
    """LLM provider 的可热替换引用（实现 LLMProvider 协议，鸭子类型可用）。

    ChatPipeline / MemoryService / SettingsService 统一持有槽（而非裸 provider）：
    "换 provider"只有 ``swap`` 一处，所有持有者下一个请求即用新配置。
    """

    def __init__(self, provider: LLMProvider) -> None:
        self._provider = provider

    @property
    def current(self) -> LLMProvider:
        return self._provider

    def swap(self, provider: LLMProvider) -> None:
        """换入新 provider（旧实例的进行中请求自然结束，不受影响）。"""
        self._provider = provider

    # ---------- LLMProvider 协议（委托当前 provider） ----------

    async def stream_chat(
        self, messages: Sequence[ChatMessage], **opts: Any
    ) -> AsyncIterator[Chunk]:
        async for chunk in self._provider.stream_chat(messages, **opts):
            yield chunk

    async def embed(self, texts: Sequence[str]) -> list[list[float]]:
        return await self._provider.embed(texts)

    async def test(self) -> tuple[bool, str]:
        return await self._provider.test()

    async def probe(self, **overrides: Any) -> ProbeResult:
        return await self._provider.probe(**overrides)


class TtsSlot:
    """TTS provider 的可热替换引用（实现 TTSProvider 协议；未装配时 ``current=None``）。"""

    def __init__(self, provider: TTSProvider | None = None) -> None:
        self._provider = provider

    @property
    def current(self) -> TTSProvider | None:
        return self._provider

    def swap(self, provider: TTSProvider | None) -> None:
        self._provider = provider

    async def synthesize(self, text: str) -> bytes:
        provider = self._provider
        if provider is None:
            # 兜底：可用性回调（VoiceOut.available）正常时不会走到这里
            raise TtsError(TtsErrorCode.TTS_NETWORK, "语音未装配或已停用")
        return await provider.synthesize(text)


class Runtime:
    """运行时装配控制面：持有当前配置与各模块活引用，负责热重装配（main 装配）。"""

    def __init__(
        self,
        config: AppConfig,
        *,
        reminder_store: ReminderStore | None = None,
        notebook: NotebookService | None = None,
    ) -> None:
        self._config = config
        self._llm = LlmSlot(create_llm_provider(config))
        self._tts = TtsSlot()
        # 提醒服务（2026-10-18）：有存储才装配；配置/免打扰都取运行时活引用，
        # 设置保存后下一 tick 即生效。提醒工具随之注册（backend 型，见 modules/tools）。
        self._reminders = (
            ReminderService(
                reminder_store,
                config=lambda: self._config.reminders,
                quiet_hours=lambda: self._config.behavior.quiet_hours,
            )
            if reminder_store is not None
            else None
        )
        # 记忆本服务（2026-10-18）：由 main 装配后注入；工具随之注册。
        self._notebook = notebook
        # §4.7：内置工具（装配后只读）；未装配提醒/记忆本/搜索时注册表与旧版一致
        self._tools = build_default_registry(self._reminders, self._notebook)
        self._engine: BehaviorEngine | None = None
        self._memory: MemoryService | None = None

    # ---------------------------------------------------------------- 只读视图

    @property
    def config(self) -> AppConfig:
        """当前运行时配置（设置面板保存后即换新）。"""
        return self._config

    @property
    def llm(self) -> LlmSlot:
        return self._llm

    @property
    def tts(self) -> TtsSlot:
        return self._tts

    @property
    def tools(self) -> ToolRegistry:
        """内置工具注册表（§4.7；ChatPipeline 构造时注入，生产自动启用工具机制）。"""
        return self._tools

    @property
    def reminders(self) -> ReminderService | None:
        """提醒调度服务（未装配存储时为 None；dispatcher 绑定宠物连接）。"""
        return self._reminders

    def pet_name(self) -> str:
        """当前宠物名字（ChatPipeline 每轮组装 system prompt 时动态读，§7.6.3）。"""
        return self._config.pet.name

    def voice_available(self) -> bool:
        """当前语音是否可用（VoiceOut.available 的动态依据）。"""
        return self._config.voice.enabled and self._tts.current is not None

    # ---------------------------------------------------------------- 装配

    def bind_behavior(self, engine: BehaviorEngine) -> None:
        """挂接行为引擎（main 装配；热重装配时随配置联动启停）。"""
        self._engine = engine

    def bind_memory(self, service: MemoryService) -> None:
        """挂接记忆提取服务（main 装配；热重装配时随配置联动启停）。"""
        self._memory = service

    def voice_factory(self) -> VoiceOut:
        """每条连接一个语音出站（server 装配点，§4.4/§7.6.3）。

        恒返回 VoiceOut（provider 槽 + ``enabled`` 回调动态判断可用性）：
        - 语音未启用 / 未装配：``available=False``，对话链路不走语音（同"未装配"）；
        - 已建立的连接也能感知开关与音色的热更新（无需重连）。
        """
        return VoiceOut(self._tts, enabled=self.voice_available)

    def start_services(self) -> None:
        """启动后台服务（uvicorn 就绪后由 main 调用）：按当前配置决定是否启用。"""
        if self._engine is not None:
            self._engine.start()  # 引擎自判 [behavior].enabled 并记日志
        if self._memory is not None and self._config.memory.enabled:
            self._memory.start()
        if self._reminders is not None:
            self._reminders.start()  # 服务自判 [reminders].enabled 并记日志

    async def stop_services(self) -> None:
        """停止后台服务（进程退出前由 main 调用）。"""
        if self._reminders is not None:
            await self._reminders.stop()
        if self._memory is not None:
            await self._memory.stop()
        if self._engine is not None:
            await self._engine.stop()

    # ---------------------------------------------------------------- 热重装配

    async def apply(self, config: AppConfig) -> None:
        """把新配置分派到各模块（§7.6.3，保存即生效）。

        单项装配失败只降级（如未知 TTS provider → 语音暂不可用）、不整体失败：
        配置本身已通过校验并落盘，不应因旁路能力装配失败而回滚。
        """
        self._config = config
        self.apply_llm(config)
        self.apply_voice(config)
        await self.apply_behavior(config)
        await self.apply_memory(config)
        await self.apply_reminders(config)

    def apply_llm(self, config: AppConfig) -> None:
        """LLM provider 热更新：按新 base_url / model / 采样参数重建并换入槽。"""
        self._llm.swap(create_llm_provider(config))
        logger.info(
            "LLM 热重装配完成：base_url={} model={}",
            config.llm.base_url,
            config.llm.model,
        )

    def apply_voice(self, config: AppConfig) -> None:
        """TTS provider 热更新：按 [voice] 重建换入槽；未启用 / 装配失败 → 槽置空。

        - ``enabled=false``：槽置空——已建立的连接经 VoiceOut 的可用性回调立刻静默；
        - 未知 provider（ValueError）：记日志降级，不抛出（语音是旁路能力）。
        """
        if not config.voice.enabled:
            self._tts.swap(None)
            logger.info("语音热重装配：已停用（[voice].enabled=false）")
            return
        try:
            provider = create_tts_provider(
                provider=config.voice.provider, voice=config.voice.voice
            )
        except ValueError as exc:
            self._tts.swap(None)
            logger.warning("语音热重装配失败，语音暂不可用：{}", exc)
            return
        self._tts.swap(provider)
        logger.info(
            "语音热重装配完成：provider={} voice={}",
            config.voice.provider,
            config.voice.voice,
        )

    async def apply_behavior(self, config: AppConfig) -> None:
        """行为引擎热更新：换配置引用 + enabled 联动启停（引擎内每轮动态读）。"""
        if self._engine is not None:
            await self._engine.update_config(config.behavior)

    async def apply_memory(self, config: AppConfig) -> None:
        """记忆服务热更新：enabled 联动启停 + 阈值换值（服务内每轮动态读）。"""
        if self._memory is not None:
            await self._memory.update_config(config.memory)

    async def apply_reminders(self, config: AppConfig) -> None:
        """提醒服务热更新：enabled 联动启停（语音/补报等参数每 tick 动态读）。"""
        if self._reminders is not None:
            await self._reminders.update_config(config.reminders)
