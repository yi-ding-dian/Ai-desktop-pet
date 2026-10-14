"""config.toml 加载（Pydantic 校验 + 默认值）。

- 结构对应设计文档 §6.3；
- 文件不存在时，向 PET_DATA_DIR 生成默认模板（含注释）；
- API key 不进此文件（存系统 keyring，见设计文档 §6.3）。
"""

from __future__ import annotations

import tomllib
from pathlib import Path

from pydantic import BaseModel, Field

from backend.shared.paths import get_config_path

DEFAULT_CONFIG_TEMPLATE = """\
# AI 桌面宠物配置文件（可手工编辑，设置面板修改后也会写回此文件）
# 注意：API key 不写入本文件（存系统 keyring）。

[llm]
# OpenAI 兼容端点（默认指向本地网关；换服务商时改这里，如 https://api.deepseek.com/v1）
base_url    = "http://192.168.0.8:3000/v1"
model       = "deepseek-flash"
temperature = 0.8
# 最大回复长度：推理型模型（如 deepseek-flash）的思考过程也消耗 token，需给足
max_tokens  = 768

[embedding]
mode  = "follow"   # follow=复用对话服务商 / custom=单独配置
model = ""

[pet]
name     = "小豆"
scale    = 1.0
idle_fps = 10

[voice]            # Phase 2
enabled  = false
provider = "edge"
voice    = "zh-CN-XiaoxiaoNeural"

[behavior]         # Phase 3
proactive_enabled = true
greeting          = true
"""


class LlmConfig(BaseModel):
    """对话模型配置（BYOK：key 在 keyring，不在此处）。"""

    base_url: str = "http://192.168.0.8:3000/v1"
    model: str = "deepseek-flash"
    temperature: float = 0.8
    # 推理型模型思考也占 token，默认给足 768，避免思考吃光导致空回复
    max_tokens: int = 768


class EmbeddingConfig(BaseModel):
    """向量化服务配置（默认复用对话服务商）。"""

    mode: str = "follow"  # follow / custom
    model: str = ""


class PetConfig(BaseModel):
    """宠物外观配置。"""

    name: str = "小豆"
    scale: float = 1.0
    idle_fps: int = 10


class VoiceConfig(BaseModel):
    """语音配置（Phase 2）。"""

    enabled: bool = False
    provider: str = "edge"
    voice: str = "zh-CN-XiaoxiaoNeural"


class BehaviorConfig(BaseModel):
    """自主行为配置（Phase 3）。"""

    proactive_enabled: bool = True
    greeting: bool = True


class AppConfig(BaseModel):
    """完整配置（缺省字段自动取默认值，容忍用户手改 TOML 的遗漏）。"""

    llm: LlmConfig = Field(default_factory=LlmConfig)
    embedding: EmbeddingConfig = Field(default_factory=EmbeddingConfig)
    pet: PetConfig = Field(default_factory=PetConfig)
    voice: VoiceConfig = Field(default_factory=VoiceConfig)
    behavior: BehaviorConfig = Field(default_factory=BehaviorConfig)


def load_config(path: Path | None = None) -> AppConfig:
    """读取 config.toml；文件不存在时生成默认模板并返回默认配置。"""
    config_path = path or get_config_path()
    if not config_path.exists():
        config_path.parent.mkdir(parents=True, exist_ok=True)
        config_path.write_text(DEFAULT_CONFIG_TEMPLATE, encoding="utf-8")
        return AppConfig()

    with config_path.open("rb") as f:
        raw = tomllib.load(f)
    return AppConfig.model_validate(raw)
