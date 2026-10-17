"""shared/config.py 单测：默认模板生成与读取 / 保存写回 / 格式校验。"""

from __future__ import annotations

from pathlib import Path

import pytest
from pydantic import ValidationError

from backend.shared.config import (
    DEFAULT_CONFIG_TEMPLATE,
    AppConfig,
    load_config,
    save_config,
)


def test_generates_default_template_when_missing(tmp_path: Path) -> None:
    path = tmp_path / "config.toml"
    cfg = load_config(path)

    assert path.exists()
    assert path.read_text(encoding="utf-8") == DEFAULT_CONFIG_TEMPLATE
    assert cfg.llm.model == "deepseek-flash"
    assert cfg.llm.base_url == ""  # 首启引导：默认未配置（引导里选服务商）
    assert cfg.llm.max_tokens == 768
    assert cfg.pet.name == "小兔"
    assert cfg.voice.enabled is True  # Phase 2：语音默认开启（失败自动降级）
    assert cfg.voice.provider == "edge"
    assert cfg.voice.voice == "zh-CN-XiaoxiaoNeural"
    assert cfg.behavior.proactive_enabled is True


def test_reads_existing_file_with_defaults_fallback(tmp_path: Path) -> None:
    path = tmp_path / "config.toml"
    path.write_text(
        '[llm]\nbase_url = "https://api.moonshot.cn/v1"\nmodel = "kimi"\n\n[pet]\nname = "毛毛"\n',
        encoding="utf-8",
    )
    cfg = load_config(path)

    assert cfg.llm.base_url == "https://api.moonshot.cn/v1"
    assert cfg.llm.model == "kimi"
    assert cfg.llm.temperature == 0.8  # 未写的字段回落默认值
    assert cfg.llm.max_tokens == 768
    assert cfg.pet.name == "毛毛"
    assert cfg.pet.idle_fps == 10


def test_invalid_value_raises_validation_error(tmp_path: Path) -> None:
    path = tmp_path / "config.toml"
    path.write_text('[llm]\ntemperature = "hot"\n', encoding="utf-8")
    with pytest.raises(ValidationError):
        load_config(path)


# ---------------------------------------------------------------- 格式校验（读取与写回同规则）


@pytest.mark.parametrize(
    "raw",
    [
        '[llm]\nbase_url = "ftp://x/v1"\n',       # 非 http(s)
        '[llm]\nbase_url = "example.com"\n',      # 无协议
        '[llm]\nbase_url = "http:///v1"\n',       # 无主机
        '[llm]\nmodel = "   "\n',                 # model 为空
        '[pet]\nname = "  "\n',                   # 名字为空
        '[behavior]\nquiet_hours = ["23:00~07:00"]\n',  # 时段分隔符错
        '[behavior]\nquiet_hours = ["25:00-07:00"]\n',  # 小时越界
    ],
)
def test_format_validators_reject_bad_values(tmp_path: Path, raw: str) -> None:
    path = tmp_path / "config.toml"
    path.write_text(raw, encoding="utf-8")
    with pytest.raises(ValidationError):
        load_config(path)


def test_valid_edge_values_accepted() -> None:
    cfg = AppConfig.model_validate(
        {
            "llm": {"base_url": "https://api.deepseek.com/v1", "model": "m"},
            "behavior": {"quiet_hours": ["00:00-23:59", "12:30-13:30", ""]},
        }
    )
    assert cfg.behavior.quiet_hours == ["00:00-23:59", "12:30-13:30", ""]  # 空条目容忍


def test_empty_base_url_is_valid_unconfigured_state() -> None:
    """空 base_url = 未配置（首启引导的合法态，放行）；模板注释同步说明。"""
    assert AppConfig.model_validate({"llm": {"base_url": ""}}).llm.base_url == ""
    assert AppConfig.model_validate({"llm": {"base_url": "   "}}).llm.base_url == ""
    assert AppConfig().llm.base_url == ""
    assert "留空 = 未配置" in DEFAULT_CONFIG_TEMPLATE
    assert 'base_url    = ""' in DEFAULT_CONFIG_TEMPLATE


def test_file_and_context_limits_defaults_and_bounds() -> None:
    """文件分析限额：默认 20k 字 / 100k tokens；边界与越界校验。"""
    cfg = AppConfig()
    assert cfg.files.max_chars == 20_000
    assert cfg.files.max_bytes == 20 * 1024 * 1024
    assert cfg.files.max_per_turn == 3
    assert cfg.files.allow_images is True
    assert cfg.files.max_image_bytes == 8 * 1024 * 1024
    assert cfg.llm.context_tokens == 100_000

    assert AppConfig.model_validate({"files": {"max_chars": 1_000}}).files.max_chars == 1_000
    assert AppConfig.model_validate({"files": {"max_chars": 100_000}}).files.max_chars == 100_000
    assert AppConfig.model_validate({"llm": {"context_tokens": 8_000}}).llm.context_tokens == 8_000
    assert (
        AppConfig.model_validate({"llm": {"context_tokens": 200_000}}).llm.context_tokens
        == 200_000
    )

    bad_values = [
        {"files": {"max_chars": 999}},
        {"files": {"max_chars": 100_001}},
        {"files": {"max_bytes": 1023}},
        {"files": {"max_per_turn": 0}},
        {"llm": {"context_tokens": 7_999}},
        {"llm": {"context_tokens": 200_001}},
    ]
    for raw in bad_values:
        with pytest.raises(ValidationError):
            AppConfig.model_validate(raw)


# ---------------------------------------------------------------- save_config（设置面板写回）


def test_save_config_roundtrip(tmp_path: Path) -> None:
    """写回 → 读回无损（含中文 / 引号 / 反斜杠 / 列表 / 浮点）。"""
    path = tmp_path / "config.toml"
    cfg = AppConfig.model_validate(
        {
            "llm": {"base_url": "https://api.moonshot.cn/v1", "model": "kimi", "temperature": 0.5},
            "pet": {"name": '毛毛"怪\\名'},
            "voice": {"enabled": False, "voice": "zh-CN-YunxiNeural"},
            "behavior": {"quiet_hours": ["23:00-07:00"]},
            "memory": {"enabled": False},
        }
    )

    save_config(cfg, path)
    back = load_config(path)

    assert back == cfg  # 全字段往返一致
    text = path.read_text(encoding="utf-8")
    assert "[llm]" in text and "quiet_hours" in text  # 结构可读
    assert "api_key" not in text  # API key 绝不写入本文件（含 key 专用字段）


def test_save_config_creates_parent_dir(tmp_path: Path) -> None:
    path = tmp_path / "nested" / "dir" / "config.toml"
    save_config(AppConfig(), path)
    assert path.exists()
    assert load_config(path).pet.name == "小兔"


# ---------------------------------------------------------------- 注释与排版保留（tomlkit 逐字段更新）


def test_save_config_preserves_comments_and_custom_sections(tmp_path: Path) -> None:
    """改 llm.model 后：其他段落的注释 / 行内注释 / 用户自定义段落全部原样保留。"""
    path = tmp_path / "config.toml"
    path.write_text(
        """# 我自己的顶部注释
[llm]
# 换服务商时改这里
base_url = "https://api.deepseek.com/v1"   # 行内备注
model    = "old-model"

[pet]
# 宠物名字，随便改
name = "小兔"

[my_custom]
note = "用户自定义内容，别动"
""",
        encoding="utf-8",
    )
    # 模拟真实路径：先载入现有配置，只改两个字段，再保存（save_config 写完整配置）
    data = load_config(path).model_dump()
    data["llm"]["model"] = "kimi"
    data["pet"]["name"] = "毛毛"
    cfg = AppConfig.model_validate(data)

    save_config(cfg, path)

    text = path.read_text(encoding="utf-8")
    # 注释与自定义内容保留
    assert "# 我自己的顶部注释" in text
    assert "# 换服务商时改这里" in text
    assert "# 行内备注" in text
    assert "# 宠物名字，随便改" in text
    assert "[my_custom]" in text and 'note = "用户自定义内容，别动"' in text
    # 值已原位更新；缺失的段落（voice/behavior/memory 等）被补建
    assert 'model    = "kimi"' in text  # 原有对齐空格保留
    assert '"毛毛"' in text
    assert "[voice]" in text and "[behavior]" in text and "[memory]" in text
    # 更新后的文件仍可被标准 tomllib 读回
    back = load_config(path)
    assert back.llm.model == "kimi" and back.pet.name == "毛毛"
    assert back.llm.base_url == "https://api.deepseek.com/v1"


def test_save_config_seeds_commented_template_when_missing(tmp_path: Path) -> None:
    """文件不存在：以默认模板（带段落注释）为种子生成，值来自传入配置。"""
    path = tmp_path / "config.toml"
    save_config(AppConfig.model_validate({"pet": {"name": "毛毛"}}), path)

    text = path.read_text(encoding="utf-8")
    assert "[llm]" in text and "#" in text  # 注释模板
    assert '"毛毛"' in text
    assert load_config(path).pet.name == "毛毛"


def test_save_config_recovers_from_broken_file(tmp_path: Path) -> None:
    """文件语法已损坏：保存不失败，以默认模板重建（用户内容无从保留，但后续可读）。"""
    path = tmp_path / "config.toml"
    path.write_text("llm = [unclosed", encoding="utf-8")

    save_config(AppConfig(), path)

    text = path.read_text(encoding="utf-8")
    assert "#" in text  # 模板注释回来了
    assert load_config(path).llm.model == "deepseek-flash"
