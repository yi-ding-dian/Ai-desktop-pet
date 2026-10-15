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
name     = "小兔"
scale    = 1.0
idle_fps = 10

[voice]            # Phase 2：语音播报（TTS）
enabled  = true
provider = "edge"
voice    = "zh-CN-XiaoxiaoNeural"

[behavior]         # Phase 3：自主行为引擎
enabled            = true
proactive_enabled  = true
greeting           = true
# 免打扰时段（本地时间，可跨午夜；空 = 无免打扰）：命中期间不做任何自主行为
quiet_hours        = []
# 自主行为的空闲间隔（秒）——两次行为之间的随机等待范围
idle_min_seconds   = 10.0
idle_max_seconds   = 40.0

[memory]           # Phase 3：长期记忆（结构化 + 规则召回；向量待网关支持 embedding）
enabled                = true
idle_seconds           = 300   # 会话空闲多久后触发记忆提取（秒）
check_interval_seconds = 15    # 空闲扫描周期（秒）
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

    name: str = "小兔"
    scale: float = 1.0
    idle_fps: int = 10


class VoiceConfig(BaseModel):
    """语音配置（Phase 2：TTS 播报，默认开启——免费零配置，失败自动降级）。"""

    enabled: bool = True
    provider: str = "edge"
    voice: str = "zh-CN-XiaoxiaoNeural"


class BehaviorConfig(BaseModel):
    """自主行为配置（Phase 3）。

    ``quiet_hours``：免打扰时段列表，条目形如 ``"23:00-07:00"``（本地时间，可跨午夜）；
    默认空列表 = 无免打扰。``idle_*_seconds``：两次行为之间的随机空闲间隔。
    """

    enabled: bool = True
    proactive_enabled: bool = True
    greeting: bool = True
    quiet_hours: list[str] = Field(default_factory=list)
    idle_min_seconds: float = 10.0
    idle_max_seconds: float = 40.0


class MemoryConfig(BaseModel):
    """长期记忆配置（Phase 3：会话空闲后后台提取，§4.3/§7.1）。

    - ``idle_seconds``：会话空闲多久后触发记忆提取（默认 5 分钟）；
    - ``check_interval_seconds``：空闲扫描周期。
    """

    enabled: bool = True
    idle_seconds: int = 300
    check_interval_seconds: int = 15


class AppConfig(BaseModel):
    """完整配置（缺省字段自动取默认值，容忍用户手改 TOML 的遗漏）。"""

    llm: LlmConfig = Field(default_factory=LlmConfig)
    embedding: EmbeddingConfig = Field(default_factory=EmbeddingConfig)
    pet: PetConfig = Field(default_factory=PetConfig)
    voice: VoiceConfig = Field(default_factory=VoiceConfig)
    behavior: BehaviorConfig = Field(default_factory=BehaviorConfig)
    memory: MemoryConfig = Field(default_factory=MemoryConfig)


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
