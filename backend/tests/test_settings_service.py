"""application/settings_service.py 单测：快照掩码 / patch 校验 / 写回与 key / 测试连接。

隔离手法与 test_secrets.py 一致：PET_DATA_DIR 指向临时目录、keyring 读写原语
用 monkeypatch 替换（不触碰真实 keyring）、脱敏集合用完即恢复。
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any

import pytest

from backend.application.runtime import Runtime
from backend.application.settings_service import ConfigInvalid, SettingsService
from backend.modules.behavior.engine import BehaviorEngine
from backend.modules.llm.provider import ProbeResult
from backend.shared import secrets
from backend.shared.config import AppConfig, BehaviorConfig, load_config

ENV_KEY = "env-key-0123456789"
NEW_KEY = "sk-new-key-abcdef123456"
MASKED_KEY = "sk-****1234"  # 形状与 mask_secret 一致（用于"掩码回显"用例）


@pytest.fixture(autouse=True)
def _isolate(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """隔离环境：数据目录 / 环境 key / keyring 原语 / 脱敏集合。"""
    monkeypatch.setenv("PET_DATA_DIR", str(tmp_path))
    monkeypatch.delenv(secrets.ENV_KEY_NAME, raising=False)
    monkeypatch.setattr(secrets, "_keyring_get", lambda: None)
    # 强制 keyring 写入失败 → key 落 600 文件（落点可断言，且不触碰真实 keyring）
    monkeypatch.setattr(secrets, "_keyring_set", lambda key: False)
    saved = set(secrets._known_secrets)
    yield tmp_path
    secrets._known_secrets.clear()
    secrets._known_secrets.update(saved)


def make_service(*, config: AppConfig | None = None) -> tuple[SettingsService, Runtime]:
    runtime = Runtime(config or AppConfig())
    return SettingsService(runtime=runtime), runtime


# ---------------------------------------------------------------- get_config 快照


def test_snapshot_masks_key_and_never_leaks_plaintext(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(secrets.ENV_KEY_NAME, ENV_KEY)
    service, _ = make_service()

    snapshot = service.snapshot()

    masked = secrets.mask_secret(ENV_KEY)
    assert snapshot["llm"]["key"] == masked
    assert snapshot["llm"]["api_key"] == masked  # 设置面板约定读取名（同值）
    assert ENV_KEY not in json.dumps(snapshot, ensure_ascii=False)
    assert snapshot["llm"]["base_url"] == ""  # 默认未配置（首启引导：选服务商）
    assert snapshot["llm"]["model"] == "deepseek-flash"
    assert snapshot["pet"]["name"] == "小兔"
    assert snapshot["voice"] == {
        "enabled": True,
        "provider": "edge",
        "voice": "zh-CN-XiaoxiaoNeural",
    }
    assert snapshot["behavior"]["proactive_enabled"] is True
    assert snapshot["behavior"]["greeting"] is True
    assert snapshot["behavior"]["quiet_hours"] == []
    assert snapshot["memory"]["enabled"] is True


def test_snapshot_without_key_marks_unconfigured() -> None:
    service, _ = make_service()
    assert service.snapshot()["llm"]["key"] == "(未配置)"


# ---------------------------------------------------------------- set_config 校验


@pytest.mark.parametrize(
    ("patch", "expect"),
    [
        ({"llm": {"base_url": "ftp://example.com/v1"}}, "http:// 或 https://"),
        ({"llm": {"base_url": "example.com"}}, "http:// 或 https://"),
        ({"llm": {"base_url": "http:///v1"}}, "缺少主机名"),
        ({"llm": {"model": "   "}}, "model 不能为空"),
        ({"behavior": {"quiet_hours": ["25:00-07:00"]}}, "HH:MM-HH:MM"),
        ({"behavior": {"quiet_hours": ["23:00~07:00"]}}, "HH:MM-HH:MM"),
        ({"pet": {"name": "   "}}, "pet.name 不能为空"),
        ({"pet": {"name": "名字" * 11}}, "过长"),
        ({"pet": {"nope": 1}}, "不支持的字段"),
        ({"nope": {}}, "不支持的配置项"),
        ({"llm": "oops"}, "必须是对象"),
    ],
)
def test_invalid_patch_raises_with_reason(
    patch: dict[str, Any], expect: str, tmp_path: Path
) -> None:
    async def scenario() -> None:
        service, runtime = make_service()
        with pytest.raises(ConfigInvalid) as excinfo:
            await service.apply_patch(patch)
        assert expect in excinfo.value.message
        # 校验失败不产生任何副作用：文件不落盘、运行时配置不变
        assert not (tmp_path / "config.toml").exists()
        assert runtime.config.pet.name == "小兔"

    asyncio.run(scenario())


def test_invalid_patch_leaves_state_untouched(tmp_path: Path) -> None:
    async def scenario() -> None:
        service, runtime = make_service()
        with pytest.raises(ConfigInvalid):
            await service.apply_patch({"llm": {"base_url": "臭地址"}})
        assert not (tmp_path / "config.toml").exists()
        assert runtime.config.llm.base_url == ""  # 默认未配置，校验失败也不改动

    asyncio.run(scenario())


def test_non_dict_patch_rejected() -> None:
    async def scenario() -> None:
        service, _ = make_service()
        with pytest.raises(ConfigInvalid):
            await service.apply_patch("oops")  # type: ignore[arg-type]

    asyncio.run(scenario())


def test_key_field_type_checked() -> None:
    async def scenario() -> None:
        service, _ = make_service()
        with pytest.raises(ConfigInvalid) as excinfo:
            await service.apply_patch({"key": 123})
        assert "key 必须是字符串" in excinfo.value.message

    asyncio.run(scenario())


# ---------------------------------------------------------------- set_config 保存


def test_apply_patch_saves_files_and_updates_runtime(tmp_path: Path) -> None:
    async def scenario() -> None:
        service, runtime = make_service()

        snapshot = await service.apply_patch(
            {
                "llm": {"model": "kimi", "temperature": 0.5, "context_tokens": 120_000},
                "pet": {"name": "毛毛"},
                "behavior": {"quiet_hours": ["23:00-07:00"], "proactive_enabled": False},
                "memory": {"enabled": False},
                "files": {"max_chars": 30_000, "allow_images": False},
            }
        )

        # 回执是"保存后的新快照"
        assert snapshot["llm"]["model"] == "kimi"
        assert snapshot["pet"]["name"] == "毛毛"
        assert snapshot["files"]["max_chars"] == 30_000
        assert snapshot["files"]["allow_images"] is False
        # 写回 config.toml（可被 load_config 读回，字段完整）
        saved = load_config(tmp_path / "config.toml")
        assert saved.llm.model == "kimi"
        assert saved.llm.temperature == 0.5
        assert saved.llm.context_tokens == 120_000
        assert saved.pet.name == "毛毛"
        assert saved.behavior.quiet_hours == ["23:00-07:00"]
        assert saved.behavior.proactive_enabled is False
        assert saved.memory.enabled is False
        assert saved.files.max_chars == 30_000
        assert saved.files.allow_images is False
        # 运行时配置同步换新（热重装配的基础）
        assert runtime.config.pet.name == "毛毛"
        # LLM provider 已按新配置重建
        assert runtime.llm.current._model == "kimi"  # noqa: SLF001（测试读私有）

    asyncio.run(scenario())


def test_apply_patch_writes_key_separately_not_into_toml(tmp_path: Path) -> None:
    async def scenario() -> None:
        service, _ = make_service()

        snapshot = await service.apply_patch({"pet": {"name": "小新"}, "key": NEW_KEY})

        # key 落 keyring（本测试强制失败 → 600 文件），可被读取链读回
        assert secrets.get_llm_key() == NEW_KEY
        # toml 与返回快照都不含明文
        raw = (tmp_path / "config.toml").read_text(encoding="utf-8")
        assert NEW_KEY not in raw
        assert snapshot["llm"]["key"] == secrets.mask_secret(NEW_KEY)
        assert NEW_KEY not in json.dumps(snapshot, ensure_ascii=False)

    asyncio.run(scenario())


def test_apply_patch_keeps_user_comments_in_config_file(tmp_path: Path) -> None:
    """设置面板保存不清除用户手写注释（§6.3：config.toml 用户可见、双方可编辑）。"""

    async def scenario() -> None:
        config_path = tmp_path / "config.toml"
        config_path.write_text(
            "# 我的备注：网关在局域网\n[llm]\n# 别删这个注释\nmodel = \"old\"\n",
            encoding="utf-8",
        )
        service, _ = make_service()

        await service.apply_patch({"llm": {"model": "kimi"}})

        text = config_path.read_text(encoding="utf-8")
        assert "# 我的备注：网关在局域网" in text
        assert "# 别删这个注释" in text
        assert '"kimi"' in text
        assert load_config(config_path).llm.model == "kimi"

    asyncio.run(scenario())


def test_apply_patch_accepts_key_in_llm_section(tmp_path: Path) -> None:
    """设置面板约定：key 放 ``llm.api_key``（与顶层 key 等价）；不视为配置字段。"""

    async def scenario() -> None:
        service, _ = make_service()

        snapshot = await service.apply_patch(
            {"llm": {"model": "kimi", "api_key": NEW_KEY}}
        )

        assert secrets.get_llm_key() == NEW_KEY
        assert snapshot["llm"]["model"] == "kimi"
        raw = (tmp_path / "config.toml").read_text(encoding="utf-8")
        assert NEW_KEY not in raw
        assert "api_key" not in raw  # key 专用字段绝不进 toml

    asyncio.run(scenario())


def test_empty_or_masked_key_keeps_existing(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(secrets.ENV_KEY_NAME, ENV_KEY)

    async def scenario() -> None:
        service, _ = make_service()

        await service.apply_patch({"key": "   "})  # 空 = 不修改
        assert secrets.get_llm_key() == ENV_KEY

        await service.apply_patch({"key": MASKED_KEY})  # 掩码回显（前端只拿到掩码）= 不修改
        assert secrets.get_llm_key() == ENV_KEY

        await service.apply_patch({"llm": {"api_key": MASKED_KEY}})  # llm 内位置同理
        assert secrets.get_llm_key() == ENV_KEY

        await service.apply_patch({"llm": {"api_key": ""}})
        assert secrets.get_llm_key() == ENV_KEY

        await service.apply_patch({})  # 未提供 = 不修改（空 patch 也合法）
        assert secrets.get_llm_key() == ENV_KEY

    asyncio.run(scenario())


# ---------------------------------------------------------------- set_config 热重装配


def test_voice_switch_applies_to_existing_connection() -> None:
    """已建立的语音连接（VoiceOut）在开关切换后立即感知（§7.6.3 保存即生效）。"""

    async def scenario() -> None:
        service, runtime = make_service()
        runtime.apply_voice(runtime.config)  # 启动时的首次装配
        voice = runtime.voice_factory()  # 模拟一条已建立的连接
        assert voice.available is True

        await service.apply_patch({"voice": {"enabled": False}})
        assert voice.available is False  # 下一轮对话即刻静默，无需重连

        await service.apply_patch({"voice": {"enabled": True}})
        assert voice.available is True
        assert runtime.tts.current is not None

    asyncio.run(scenario())


def test_unknown_voice_provider_degrades_without_failure() -> None:
    """未知 TTS provider：配置照常保存，语音降级为不可用（旁路能力不阻断）。"""

    async def scenario() -> None:
        service, runtime = make_service()
        snapshot = await service.apply_patch({"voice": {"provider": "不存在的引擎"}})
        assert snapshot["voice"]["provider"] == "不存在的引擎"
        assert runtime.tts.current is None

    asyncio.run(scenario())


def test_empty_base_url_stays_unconfigured_and_recovers_after_set(tmp_path: Path) -> None:
    """首启引导：空 base_url = 未配置（装配不崩、保存放行、快照为 ""）；填上地址后热装恢复。"""

    async def scenario() -> None:
        service, runtime = make_service()
        assert runtime.llm.current._base_url == ""  # 默认未配置，装配成功（不崩）

        # 保存空地址：合法（用户清空 = 回到未配置态），快照照常返回 ""（供前端判定引导）
        snapshot = await service.apply_patch({"llm": {"base_url": ""}})
        assert snapshot["llm"]["base_url"] == ""
        assert runtime.llm.current._base_url == ""

        # 填上地址：热重装配换新 provider，后续请求走新端点
        snapshot = await service.apply_patch(
            {"llm": {"base_url": "https://api.deepseek.com/v1"}}
        )
        assert snapshot["llm"]["base_url"] == "https://api.deepseek.com/v1"
        assert runtime.llm.current._base_url == "https://api.deepseek.com/v1"

        # 写回文件可读回（未配置态与已配置态都持久化正确）
        assert load_config(tmp_path / "config.toml").llm.base_url == "https://api.deepseek.com/v1"

    asyncio.run(scenario())


def test_behavior_enabled_switch_starts_and_stops_engine() -> None:
    async def scenario() -> None:
        service, runtime = make_service()
        engine = BehaviorEngine(BehaviorConfig(enabled=True))
        runtime.bind_behavior(engine)
        assert engine._task is None  # 未手动 start

        await service.apply_patch({"behavior": {"enabled": False}})
        assert engine._task is None  # 未启动过且已禁用 → 保持停止

        await service.apply_patch({"behavior": {"enabled": True}})
        assert engine._task is not None  # 热切换 → 主循环启动
        await engine.stop()

    asyncio.run(scenario())


# ---------------------------------------------------------------- test_llm


class FakeProbeProvider:
    """仅实现 probe 的替身：记录入参、返回预置结果（test_llm 用例）。"""

    def __init__(self, result: ProbeResult) -> None:
        self.result = result
        self.calls: list[dict[str, Any]] = []

    async def probe(self, **overrides: Any) -> ProbeResult:
        self.calls.append(overrides)
        return self.result


def test_test_llm_passes_overrides_and_returns_models() -> None:
    async def scenario() -> None:
        service, runtime = make_service()
        fake = FakeProbeProvider(
            ProbeResult(ok=True, message="连接成功（model=m）", models=["m", "m2"])
        )
        runtime.llm.swap(fake)  # type: ignore[arg-type]

        payload = await service.test_llm(base_url="https://x/v1", model="m", key="k-123")

        assert payload == {
            "ok": True,
            "message": "连接成功（model=m）",
            "models": ["m", "m2"],
        }
        assert fake.calls == [{"base_url": "https://x/v1", "model": "m", "api_key": "k-123"}]

    asyncio.run(scenario())


def test_test_llm_omits_models_when_unavailable_and_defaults_to_current() -> None:
    async def scenario() -> None:
        service, runtime = make_service()
        fake = FakeProbeProvider(ProbeResult(ok=False, message="无法连接 LLM 服务"))
        runtime.llm.swap(fake)  # type: ignore[arg-type]

        payload = await service.test_llm()  # 全部缺省：用当前配置 + 读取链的 key

        assert payload == {"ok": False, "message": "无法连接 LLM 服务"}
        assert "models" not in payload
        assert fake.calls == [{"base_url": None, "model": None, "api_key": None}]

    asyncio.run(scenario())
