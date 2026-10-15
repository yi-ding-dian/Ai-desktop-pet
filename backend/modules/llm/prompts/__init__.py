"""提示词模板与 system prompt 组装（设计文档 §4.1）。

本目录是 llm 域内的提示词资产：

    persona.md            ← 默认人格（"小兔"）
    emotion_directive.md  ← 情绪指令（要求 LLM 用 <emo:xxx> 切换情绪）
    memory_extract.md     ← 记忆提取（后台任务；P3 记忆与持久化）

system prompt 结构（§4.1）：

    [人格设定] + [情绪指令]

（[记忆注入] 由后续 chat/context.py 动态拼接，不在本步骤范围。）

角色系统（§4.6）预留：角色包内 persona.md 经 ``build_system_prompt(persona_text=...)``
参数注入并覆盖默认文件；本模块不 import character 模块，跨域组装由 application 完成。
"""

from __future__ import annotations

from pathlib import Path

_PROMPTS_DIR = Path(__file__).resolve().parent

# 兜底人格：persona.md 缺失/不可读时使用，保证服务不因提示词资产缺失而启动失败
_FALLBACK_PERSONA = (
    "你是「小兔」，一只活泼亲近的兔子桌宠，住在用户的电脑桌面上。"
    "用口语化、简洁的中文和用户聊天，每次回复 1~3 句话。"
)

# 兜底情绪指令：emotion_directive.md 缺失/不可读时使用
_FALLBACK_EMOTION_DIRECTIVE = (
    "回复中可在情绪变化处插入 <emo:xxx> 标签来切换表情，可用值："
    "neutral / happy / sad / angry / surprised / shy / thinking / sleepy；"
    "标签会被系统剥离、不展示给用户；没有情绪变化时可以不写（默认 neutral）。"
)

# 兜底记忆提取指令：memory_extract.md 缺失/不可读时使用（保持与文件同义的最简版）
_FALLBACK_MEMORY_EXTRACT = (
    "阅读对话记录，提炼关于用户、长期有效的信息。只输出 JSON 对象："
    '{"memories": [{"text": "一句话描述", "kind": "fact|preference|event", '
    '"importance": 0.5}], "profile": [{"key": "称呼", "value": "张三"}]}。'
    "最多 8 条记忆；没有可提炼内容时输出 {\"memories\": [], \"profile\": []}。"
)


def load_persona() -> str:
    """读取默认人格（persona.md）；读不到时返回内置兜底文本（不抛异常）。"""
    return _read_or(_PROMPTS_DIR / "persona.md", _FALLBACK_PERSONA)


def load_emotion_directive() -> str:
    """读取情绪指令（emotion_directive.md）；读不到时返回内置兜底文本。"""
    return _read_or(_PROMPTS_DIR / "emotion_directive.md", _FALLBACK_EMOTION_DIRECTIVE)


def load_memory_extract_prompt() -> str:
    """读取记忆提取提示词（memory_extract.md）；读不到时返回内置兜底文本。

    由 application 装配层加载后注入 memory 域的提取器（该域不 import 本模块）。
    """
    return _read_or(_PROMPTS_DIR / "memory_extract.md", _FALLBACK_MEMORY_EXTRACT)


def build_system_prompt(persona_text: str | None = None) -> str:
    """组装 system prompt：人格设定 + 情绪指令。

    ``persona_text`` 为 None 时使用默认 persona.md；角色系统接入后由 application
    以角色包的 persona.md 内容传入（§4.6），覆盖默认人格。
    """
    persona = (
        persona_text if persona_text is not None else load_persona()
    ).strip() or _FALLBACK_PERSONA
    directive = load_emotion_directive()
    return f"{persona}\n\n---\n\n{directive}"


def _read_or(path: Path, fallback: str) -> str:
    """读文本文件；任何读取失败返回兜底文本。"""
    try:
        text = path.read_text(encoding="utf-8").strip()
    except OSError:
        return fallback
    return text or fallback
