"""config.toml 加载与写回（Pydantic 校验 + 默认值）。

- 结构对应设计文档 §6.3；
- 文件不存在时，向 PET_DATA_DIR 生成默认模板（含注释）；
- ``save_config``：设置面板保存后把配置写回 config.toml——**保留原有注释与排版**
  的逐字段更新（tomlkit）；格式类校验（base_url / quiet_hours 等）收敛在本文件的
  Pydantic 校验器里，读取（手改文件）与写回（设置面板）走同一套规则；
- API key 不进此文件（存系统 keyring，见设计文档 §6.3）。
"""

from __future__ import annotations

import contextlib
import os
import re
import tempfile
import tomllib
from pathlib import Path

import tomlkit
from loguru import logger
from pydantic import BaseModel, Field, field_validator

from backend.shared.paths import get_config_path

DEFAULT_CONFIG_TEMPLATE = """\
# AI 桌面宠物配置文件（可手工编辑，设置面板修改后也会写回此文件）
# 注意：API key 不写入本文件（存系统 keyring）。

[llm]
# OpenAI 兼容端点：留空 = 未配置（首启引导里选服务商，或手工填，如 https://api.deepseek.com/v1）
base_url    = ""
model       = "deepseek-flash"
temperature = 0.8
# 最大回复长度：推理型模型（如 deepseek-flash）的思考过程也消耗 token，需给足
max_tokens  = 768
# 上下文预算（tokens）：历史 + 记忆 + 文件 + 问题超过此值时先丢历史；文件仍超则拒绝。
# 注意不要超过所用模型的实际上下文窗口（8,000–200,000）。
context_tokens = 100000

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

[files]            # 文件分析：本地文本/代码文件的读取限额
# 本轮所有附件正文合计上限（字）。超过直接拒绝、不调用模型（1,000–100,000）
max_chars    = 20000
# 单个文件字节上限（超过则不读入；默认 20MB）
max_bytes    = 20971520
# 图片（需要多模态模型）：PNG/JPEG/WebP/GIF，单张上限 8MB
allow_images    = true
max_image_bytes = 8388608
# 单轮最多几个文件/图片
max_per_turn = 3
"""


#: 免打扰时段条目格式：HH:MM-HH:MM（24 小时制；与行为引擎 rules.parse_quiet_hours 同义）
_QUIET_HOURS_PATTERN = re.compile(r"^([01]\d|2[0-3]):[0-5]\d-([01]\d|2[0-3]):[0-5]\d$")


class LlmConfig(BaseModel):
    """对话模型配置（BYOK：key 在 keyring，不在此处）。

    ``base_url`` 默认空 = **未配置态**（首启引导：用户还没选服务商；
    留空合法，聊天时以 error{LLM_NOT_CONFIGURED} 引导去设置）。
    """

    base_url: str = ""
    model: str = "deepseek-flash"
    temperature: float = 0.8
    # 推理型模型思考也占 token，默认给足 768，避免思考吃光导致空回复
    max_tokens: int = 768
    # 上下文预算（tokens，含输入 + 输出预留）：超预算先丢历史、文件仍超则拒绝。
    # 100k 是产品默认上限；实际使用须 ≤ 模型上下文窗口（由用户在设置里调整）。
    context_tokens: int = 100_000

    @field_validator("context_tokens")
    @classmethod
    def _check_context_tokens(cls, value: int) -> int:
        """夹在 8,000–200,000：太小连文件都放不下，太大容易超过模型窗口。"""
        if value < 8_000 or value > 200_000:
            raise ValueError("llm.context_tokens 必须在 8,000–200,000 之间")
        return value

    @field_validator("base_url")
    @classmethod
    def _check_base_url(cls, value: str) -> str:
        """空 = 未配置（合法态，放行）；非空必须是以 http(s):// 开头、含主机的合法端点。"""
        text = value.strip()
        if not text:
            return ""
        if not text.startswith(("http://", "https://")):
            raise ValueError("base_url 必须是 http:// 或 https:// 开头的地址")
        if not text.split("://", 1)[1].split("/", 1)[0]:
            raise ValueError("base_url 缺少主机名（如 http://127.0.0.1:3000/v1）")
        return text

    @field_validator("model")
    @classmethod
    def _check_model(cls, value: str) -> str:
        text = value.strip()
        if not text:
            raise ValueError("model 不能为空")
        return text


class EmbeddingConfig(BaseModel):
    """向量化服务配置（默认复用对话服务商）。"""

    mode: str = "follow"  # follow / custom
    model: str = ""


class PetConfig(BaseModel):
    """宠物外观配置。"""

    name: str = "小兔"
    scale: float = 1.0
    idle_fps: int = 10

    @field_validator("name")
    @classmethod
    def _check_name(cls, value: str) -> str:
        """宠物名字：非空、不宜过长（它会被注入 system prompt 并展示在 UI 上）。"""
        text = value.strip()
        if not text:
            raise ValueError("pet.name 不能为空（请给宠物起一个名字）")
        if len(text) > 20:
            raise ValueError("pet.name 过长（最多 20 个字符）")
        return text


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

    @field_validator("quiet_hours")
    @classmethod
    def _check_quiet_hours(cls, value: list[str]) -> list[str]:
        """条目必须形如 ``HH:MM-HH:MM``（空串条目容忍，与行为引擎解析器一致）。"""
        checked: list[str] = []
        for item in value:
            text = str(item).strip()
            if text and not _QUIET_HOURS_PATTERN.match(text):
                raise ValueError(
                    f"quiet_hours 条目格式应为 'HH:MM-HH:MM'（如 '23:00-07:00'）：{item!r}"
                )
            checked.append(text)
        return checked


class MemoryConfig(BaseModel):
    """长期记忆配置（Phase 3：会话空闲后后台提取，§4.3/§7.1）。

    - ``idle_seconds``：会话空闲多久后触发记忆提取（默认 5 分钟）；
    - ``check_interval_seconds``：空闲扫描周期。
    """

    enabled: bool = True
    idle_seconds: int = 300
    check_interval_seconds: int = 15


class FileConfig(BaseModel):
    """文件分析限额（P1：本地文本/代码文件）。

    ``max_chars`` 是**本轮合计**（不是单文件各自）——两个 9k 字文件合计 18k，
    默认 20k 尚可；超过就直接拒绝整轮，避免"单看都没超、合起来爆预算"。
    """

    max_chars: int = 20_000
    max_bytes: int = 20 * 1024 * 1024
    max_per_turn: int = 3
    #: 是否允许发送图片（需多模态模型；关闭时图片在本地被拒绝，不发 API 请求）
    allow_images: bool = True
    #: 单张图片字节上限（base64 后约 +33%，默认 8MB）
    max_image_bytes: int = 8 * 1024 * 1024

    @field_validator("max_chars")
    @classmethod
    def _check_max_chars(cls, value: int) -> int:
        if value < 1_000 or value > 100_000:
            raise ValueError("files.max_chars 必须在 1,000–100,000 之间")
        return value

    @field_validator("max_bytes")
    @classmethod
    def _check_max_bytes(cls, value: int) -> int:
        if value < 1024 * 1024 or value > 100 * 1024 * 1024:
            raise ValueError("files.max_bytes 必须在 1MB–100MB 之间")
        return value

    @field_validator("max_per_turn")
    @classmethod
    def _check_max_per_turn(cls, value: int) -> int:
        if value < 1 or value > 10:
            raise ValueError("files.max_per_turn 必须在 1–10 之间")
        return value

    @field_validator("max_image_bytes")
    @classmethod
    def _check_max_image_bytes(cls, value: int) -> int:
        if value < 1024 * 1024 or value > 20 * 1024 * 1024:
            raise ValueError("files.max_image_bytes 必须在 1MB–20MB 之间")
        return value


class AppConfig(BaseModel):
    """完整配置（缺省字段自动取默认值，容忍用户手改 TOML 的遗漏）。"""

    llm: LlmConfig = Field(default_factory=LlmConfig)
    embedding: EmbeddingConfig = Field(default_factory=EmbeddingConfig)
    pet: PetConfig = Field(default_factory=PetConfig)
    voice: VoiceConfig = Field(default_factory=VoiceConfig)
    behavior: BehaviorConfig = Field(default_factory=BehaviorConfig)
    memory: MemoryConfig = Field(default_factory=MemoryConfig)
    files: FileConfig = Field(default_factory=FileConfig)


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


def save_config(config: AppConfig, path: Path | None = None) -> Path:
    """把配置写回 config.toml（保留原有注释与排版的逐字段更新，原子落盘）；返回写入路径。

    - 已存在的文件：用 tomlkit 原位更新已知字段——**用户手写的注释、排版与
      自定义段落原样保留**（§6.3：本文件用户可见、设置面板可读写）；
    - 文件不存在 / 语法已损坏：以内置默认模板为种子生成（含段落注释）；
    - **API key 绝不写入本文件**（key 单独走 keyring，见 shared.secrets）。
    """
    config_path = path or get_config_path()
    config_path.parent.mkdir(parents=True, exist_ok=True)

    document = _load_document(config_path)
    _update_document(document, config)

    # 原子写：临时文件 + os.replace——避免半写文件被随后的 load_config 读到
    fd, tmp_name = tempfile.mkstemp(
        prefix=".config-", suffix=".tmp", dir=config_path.parent
    )
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(tomlkit.dumps(document))
        os.replace(tmp_name, config_path)
    except BaseException:
        with contextlib.suppress(OSError):
            os.unlink(tmp_name)
        raise
    return config_path


def _load_document(config_path: Path) -> tomlkit.TOMLDocument:
    """读取待更新的 TOML 文档：文件合法 → 原位保留；不存在 / 损坏 → 默认模板种子。"""
    if not config_path.exists():
        return tomlkit.parse(DEFAULT_CONFIG_TEMPLATE)
    try:
        return tomlkit.parse(config_path.read_text(encoding="utf-8"))
    except tomlkit.exceptions.ParseError as exc:
        # 语法已损坏（用户手改出错）：无从保留，以默认模板重建——保存总能成功
        logger.warning("config.toml 语法损坏，本次保存以默认模板重建：{}", exc)
        return tomlkit.parse(DEFAULT_CONFIG_TEMPLATE)


def _update_document(document: tomlkit.TOMLDocument, config: AppConfig) -> None:
    """把配置逐字段写入文档：已有字段原位更新（注释保留）、缺段补建、未知内容不动。"""
    for section, fields in config.model_dump().items():
        table = document.get(section)
        if not isinstance(table, tomlkit.items.Table):
            # 缺段 / 用户写成了非表：整段重建（其余段落不受影响）
            table = tomlkit.table()
            document[section] = table
        for name, value in fields.items():
            table[name] = value
