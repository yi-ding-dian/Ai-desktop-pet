"""application/runtime.py 与热重装配单测（§7.6.3"保存即生效"的机制点）。

覆盖：
- LlmSlot / TtsSlot：swap 后所有委托调用走新 provider；
- create_llm_provider：配置 → provider 字段映射；
- Runtime.apply_*：llm / voice 的装配与降级，behavior / memory 的启停联动；
- BehaviorEngine.update_config / MemoryService.update_config：开关与动态参数。
"""

from __future__ import annotations

import asyncio
from pathlib import Path

import pytest

from backend.application.memory_service import MemoryService
from backend.application.runtime import LlmSlot, Runtime, TtsSlot, create_llm_provider
from backend.application.session import SessionManager
from backend.modules.behavior.engine import BehaviorEngine
from backend.modules.chat.history import HistoryStore
from backend.modules.llm.provider import ChatMessage, Chunk, ProbeResult
from backend.modules.memory.profile import ProfileStore
from backend.modules.memory.store import MemoryStore
from backend.shared.config import AppConfig, BehaviorConfig, MemoryConfig
from backend.shared.db import connect_db
from backend.shared.errors import TtsError
from fakes import FAKE_MP3, FakeTTSProvider


def cfg_with(config: AppConfig, **sections: dict) -> AppConfig:
    """按域覆盖生成新配置（模拟 set_config 合并校验后的新 AppConfig）。"""
    data = config.model_dump()
    for section, values in sections.items():
        data[section].update(values)
    return AppConfig.model_validate(data)


class RecordingProvider:
    """记录调用并回显标记的 LLM 替身（验证槽的委托与热替换）。"""

    def __init__(self, tag: str) -> None:
        self.tag = tag
        self.calls: list[str] = []

    async def stream_chat(self, messages, **opts):  # noqa: ANN001, ANN003
        self.calls.append("stream_chat")
        yield Chunk(text=self.tag)
        yield Chunk(text="", finished=True)

    async def embed(self, texts):  # noqa: ANN001
        self.calls.append("embed")
        return [[float(len(texts))]]

    async def test(self) -> tuple[bool, str]:
        self.calls.append("test")
        return True, f"{self.tag}-ok"

    async def probe(self, **overrides):  # noqa: ANN003
        self.calls.append("probe")
        return ProbeResult(ok=True, message=self.tag, models=None)


# ---------------------------------------------------------------- 槽（热替换引用）


def test_llm_slot_delegates_and_swaps() -> None:
    async def scenario() -> None:
        first = RecordingProvider("a")
        slot = LlmSlot(first)

        chunks = [c async for c in slot.stream_chat([ChatMessage(role="user", content="hi")])]
        assert chunks[0] == Chunk(text="a")
        assert await slot.test() == (True, "a-ok")

        second = RecordingProvider("b")
        slot.swap(second)
        assert slot.current is second
        chunks = [c async for c in slot.stream_chat([])]
        assert chunks[0] == Chunk(text="b")
        assert (await slot.probe()).message == "b"
        assert await slot.embed(["x", "y"]) == [[2.0]]
        # 旧实例不再被触达
        assert first.calls == ["stream_chat", "test"]

    asyncio.run(scenario())


def test_tts_slot_empty_raises_and_swap_delegates() -> None:
    async def scenario() -> None:
        slot = TtsSlot()
        assert slot.current is None
        with pytest.raises(TtsError):
            await slot.synthesize("你好")

        fake = FakeTTSProvider()
        slot.swap(fake)
        assert await slot.synthesize("你好") == FAKE_MP3

        slot.swap(None)
        assert slot.current is None

    asyncio.run(scenario())


def test_create_llm_provider_maps_config() -> None:
    provider = create_llm_provider(
        AppConfig.model_validate(
            {"llm": {"base_url": "https://api.moonshot.cn/v1", "model": "kimi", "temperature": 0.3}}
        )
    )
    assert provider._base_url == "https://api.moonshot.cn/v1"  # noqa: SLF001（测试读私有）
    assert provider._model == "kimi"  # noqa: SLF001
    assert provider._temperature == 0.3  # noqa: SLF001


# ---------------------------------------------------------------- Runtime 装配


def test_runtime_apply_llm_swaps_provider() -> None:
    base = AppConfig()
    runtime = Runtime(base)
    old = runtime.llm.current

    runtime.apply_llm(cfg_with(base, llm={"base_url": "https://api.moonshot.cn/v1", "model": "kimi"}))

    assert runtime.llm.current is not old
    assert runtime.llm.current._model == "kimi"  # noqa: SLF001
    assert runtime.llm.current._base_url == "https://api.moonshot.cn/v1"  # noqa: SLF001


def test_runtime_assembles_default_tool_registry() -> None:
    """Runtime 装配内置工具注册表（§4.7）：main 构造 ChatPipeline 时注入。"""
    runtime = Runtime(AppConfig())
    assert [spec.name for spec in runtime.tools.all()] == [
        "open_settings",
        "open_work",
    ]


def test_runtime_apply_voice_matrix() -> None:
    base = AppConfig()
    runtime = Runtime(base)

    # 未启用 → 槽置空（语音不可用）
    runtime.apply_voice(cfg_with(base, voice={"enabled": False}))
    assert runtime.tts.current is None

    # 未知 provider → 降级置空，不抛异常
    runtime.apply_voice(cfg_with(base, voice={"provider": "不存在的引擎"}))
    assert runtime.tts.current is None

    # 合法配置 → 装配成功
    runtime.apply_voice(cfg_with(base, voice={"voice": "zh-CN-YunxiNeural"}))
    assert runtime.tts.current is not None

    # 已装配后关闭 → 槽再次置空
    runtime.apply_voice(cfg_with(base, voice={"enabled": False}))
    assert runtime.tts.current is None


def test_voice_factory_unavailable_before_assembly() -> None:
    runtime = Runtime(AppConfig())
    voice = runtime.voice_factory()
    assert voice.available is False  # 槽未装配：对话链路不走语音（同"未装配"）


def test_runtime_apply_without_behavior_and_memory_is_safe() -> None:
    async def scenario() -> None:
        runtime = Runtime(AppConfig())
        await runtime.apply(AppConfig())  # 未 bind 引擎/记忆服务：静默跳过
        runtime.start_services()  # 同理不抛
        await runtime.stop_services()

    asyncio.run(scenario())


# ---------------------------------------------------------------- 行为 / 记忆热更新


def test_behavior_engine_update_config_start_stop_and_idempotent() -> None:
    async def scenario() -> None:
        engine = BehaviorEngine(BehaviorConfig(enabled=False))
        engine.start()  # 未启用：不启动（自判）
        assert engine._task is None

        await engine.update_config(
            BehaviorConfig(enabled=True, idle_min_seconds=5.0, idle_max_seconds=6.0)
        )
        assert engine._task is not None  # 热切换 → 主循环启动
        assert engine._config.idle_min_seconds == 5.0  # 动态读点已换新值

        task = engine._task
        await engine.update_config(BehaviorConfig(enabled=True))  # 幂等：不重启
        assert engine._task is task

        await engine.update_config(BehaviorConfig(enabled=False))
        assert engine._task is None  # 关闭 → 主循环停止

        await engine.update_config(BehaviorConfig(enabled=True))  # 再次开启 → 重新启动
        assert engine._task is not None
        await engine.stop()

    asyncio.run(scenario())


def make_memory_service(tmp_path: Path) -> MemoryService:
    conn = connect_db(tmp_path / "pet.db")
    history = HistoryStore(conn)
    return MemoryService(
        provider=RecordingProvider("m"),
        store=MemoryStore(conn),
        profile_store=ProfileStore(conn),
        sessions=SessionManager(store=history),
        history=history,
        prompt="（测试提示词）",
    )


def test_memory_service_update_config_toggle_and_params(tmp_path: Path) -> None:
    async def scenario() -> None:
        service = make_memory_service(tmp_path)
        assert service._task is None

        await service.update_config(
            MemoryConfig(enabled=True, idle_seconds=42, check_interval_seconds=7)
        )
        assert service._task is not None
        assert service._idle_seconds == 42.0
        assert service._check_interval == 7.0

        await service.update_config(MemoryConfig(enabled=False))  # 关闭 → 循环停止
        assert service._task is None

        await service.update_config(MemoryConfig(enabled=True))  # 再次开启 → 幂等启动
        assert service._task is not None

    asyncio.run(scenario())


def test_runtime_start_and_stop_services(tmp_path: Path) -> None:
    async def scenario() -> None:
        config = AppConfig()
        runtime = Runtime(config)
        engine = BehaviorEngine(config.behavior)
        memory = make_memory_service(tmp_path)
        runtime.bind_behavior(engine)
        runtime.bind_memory(memory)

        runtime.start_services()
        assert engine._task is not None
        assert memory._task is not None

        await runtime.stop_services()
        assert engine._task is None
        assert memory._task is None

    asyncio.run(scenario())
