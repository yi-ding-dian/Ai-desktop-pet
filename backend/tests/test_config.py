"""shared/config.py 单测：默认模板生成与读取。"""

from __future__ import annotations

from pathlib import Path

import pytest
from pydantic import ValidationError

from backend.shared.config import DEFAULT_CONFIG_TEMPLATE, load_config


def test_generates_default_template_when_missing(tmp_path: Path) -> None:
    path = tmp_path / "config.toml"
    cfg = load_config(path)

    assert path.exists()
    assert path.read_text(encoding="utf-8") == DEFAULT_CONFIG_TEMPLATE
    assert cfg.llm.model == "deepseek-flash"
    assert cfg.llm.base_url == "http://192.168.0.8:3000/v1"
    assert cfg.llm.max_tokens == 768
    assert cfg.pet.name == "小豆"
    assert cfg.voice.enabled is False
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
