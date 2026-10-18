"""记忆提取（§4.3 / §7.1 时序结尾：会话空闲后后台任务）。

流程：对话记录 → 专用提示词（``llm/prompts/memory_extract.md``，由装配层
注入本类，避免 memory 域直接依赖 llm 域）→ 注入的补全回调（application 用
对话 provider 实现）→ JSON 解析（**容错：输出不合规时不崩**）→ 去重
（与已有记忆高度相似则跳过）→ 入库 → 同时更新画像 KV。

设计要点：
- ``complete`` 为注入的 ``async (prompt) -> str`` 回调——memory 域不 import
  llm 域任何东西，依赖方向保持 interfaces → application → modules → shared；
- 解析器对模型输出宽容：容忍 markdown 代码块、前后解释文字、字段缺失/
  类型错误（kind 归一、importance 截断）；整体不可解析时按空结果处理；
- 去重使用字符级相似度（bigram Dice，见 store.similarity）——无 embedding
  网关下的近似方案，向量接入后替换为余弦相似度。
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from typing import Awaitable, Callable, Protocol, Sequence

from loguru import logger

from backend.modules.memory.profile import MAX_KEY_LEN, MAX_VALUE_LEN, ProfileStore
from backend.modules.memory.store import (
    KIND_VALUES,
    MAX_MEMORY_TEXT_LEN,
    SIMILARITY_THRESHOLD,
    Memory,
    MemoryStore,
    similarity,
)

#: 提取输出条数上限（提示词同样要求"宁缺毋滥"；此处为硬约束兜底）
EXTRACT_MAX_MEMORIES = 8
EXTRACT_MAX_PROFILE_ITEMS = 8
#: 单次提取最多喂入的对话条数（最近 N 条，控制 token 成本）
TRANSCRIPT_MAX_MESSAGES = 40
#: importance 缺省值（模型没给时）
DEFAULT_IMPORTANCE = 0.5


class MessageLike(Protocol):
    """对话消息的结构化协议（role/content 属性）。

    用结构化子类型而非 import llm 域的 ChatMessage——application.session 的
    历史消息天然满足（鸭子类型），memory 域保持对 llm 域的零依赖。
    """

    role: str
    content: str


#: 补全回调：prompt → 模型全文输出（由 application 装配层注入实现）
CompleteFn = Callable[[str], Awaitable[str]]


@dataclass(frozen=True)
class ExtractedMemory:
    """解析后的一条待入库记忆。"""

    text: str
    kind: str
    importance: float


@dataclass(frozen=True)
class ExtractedProfile:
    """解析后的一条待更新画像。"""

    key: str
    value: str


@dataclass
class ExtractionResult:
    """一次提取的落库结果（供日志/测试/手动触发入口观察）。"""

    ok: bool  # LLM 调用与解析是否成功（False=异常降级，未写任何数据）
    added: list[Memory] = field(default_factory=list)  # 新入库记忆
    duplicates: int = 0  # 因与已有/批内记忆高度相似而跳过的条数
    forgotten: int = 0  # 撞上记忆本"遗忘名单"而跳过的条数
    profile_keys: list[str] = field(default_factory=list)  # 更新/新增的画像 key
    note: str = ""  # 结果摘要（失败原因已脱敏）


# ---------------------------------------------------------------- 解析（容错）


_CODEBLOCK_RE = re.compile(r"```(?:json)?\s*([\s\S]*?)```", re.IGNORECASE)


def _load_json_loose(raw: str) -> object | None:
    """从模型输出中尽力提取 JSON：原文 → 代码块 → 首尾括号切片。"""
    text = (raw or "").strip()
    if not text:
        return None
    candidates: list[str] = [text]
    candidates.extend(match.group(1) for match in _CODEBLOCK_RE.finditer(text))
    for open_ch, close_ch in (("[", "]"), ("{", "}")):
        start, end = text.find(open_ch), text.rfind(close_ch)
        if start != -1 and end > start:
            candidates.append(text[start : end + 1])
    for candidate in candidates:
        try:
            return json.loads(candidate)
        except (json.JSONDecodeError, ValueError):
            continue
    return None


def _parse_memory_item(item: object) -> ExtractedMemory | None:
    """单条记忆的宽容解析：text 缺失/为空 → 丢弃；kind 归一；importance 截断。"""
    if not isinstance(item, dict):
        return None
    text = str(item.get("text") or "").strip()[:MAX_MEMORY_TEXT_LEN]
    if not text:
        return None
    kind = item.get("kind")
    if kind not in KIND_VALUES:
        kind = "fact"  # 未知类别归一到最保守的 fact（模型偶发跑偏时的兜底）
    try:
        importance = float(item.get("importance", DEFAULT_IMPORTANCE))
    except (TypeError, ValueError):
        importance = DEFAULT_IMPORTANCE
    importance = max(0.0, min(1.0, importance))
    return ExtractedMemory(text=text, kind=kind, importance=importance)


def _parse_profile_item(item: object) -> ExtractedProfile | None:
    if not isinstance(item, dict):
        return None
    key = str(item.get("key") or "").strip()[:MAX_KEY_LEN]
    value = str(item.get("value") or "").strip()[:MAX_VALUE_LEN]
    if not key or not value:
        return None
    return ExtractedProfile(key=key, value=value)


def parse_extraction(raw: str) -> tuple[list[ExtractedMemory], list[ExtractedProfile]]:
    """解析模型输出，返回 ``(记忆列表, 画像列表)``。

    期望结构（提示词 memory_extract.md 指定）::

        {"memories": [{"text": ..., "kind": "fact|preference|event", "importance": 0.7}],
         "profile":  [{"key": "称呼", "value": "张三"}]}

    容错（任何一步失败都不抛异常，降级为空结果）：
    - 顶层直接是数组 → 按 memories 解析（无画像）；
    - 输出被 markdown 代码块或解释文字包裹 → 尽力定位 JSON；
    - 条目字段缺失/类型错误 → 单条丢弃或取默认值。
    """
    try:
        data = _load_json_loose(raw)
        if data is None:
            if (raw or "").strip():
                logger.warning("记忆提取输出不是有效 JSON，已忽略本次提取")
            return [], []

        if isinstance(data, list):
            memories_raw, profile_raw = data, []
        elif isinstance(data, dict):
            memories_raw = data.get("memories") or []
            profile_raw = data.get("profile") or []
        else:
            logger.warning("记忆提取输出结构异常（{}），已忽略", type(data).__name__)
            return [], []

        memories = [
            parsed
            for item in (memories_raw if isinstance(memories_raw, list) else [])[:EXTRACT_MAX_MEMORIES]
            if (parsed := _parse_memory_item(item)) is not None
        ]
        profiles = [
            parsed
            for item in (profile_raw if isinstance(profile_raw, list) else [])[:EXTRACT_MAX_PROFILE_ITEMS]
            if (parsed := _parse_profile_item(item)) is not None
        ]
        return memories, profiles
    except Exception:  # 解析永不抛出：后台任务不因模型输出异常而中断
        logger.exception("记忆提取输出解析发生未预期异常，已忽略本次提取")
        return [], []


def format_transcript(messages: Sequence[MessageLike], *, limit: int = TRANSCRIPT_MAX_MESSAGES) -> str:
    """把最近 limit 条对话渲染成提取消用的纯文本（省略空消息）。"""
    labels = {"user": "用户", "assistant": "宠物", "system": "系统"}
    lines: list[str] = []
    for message in list(messages)[-limit:]:
        content = (getattr(message, "content", "") or "").strip()
        if not content:
            continue
        role = labels.get(getattr(message, "role", ""), str(getattr(message, "role", "")))
        lines.append(f"{role}：{content}")
    return "\n".join(lines)


# ---------------------------------------------------------------- 提取器


class MemoryExtractor:
    """记忆提取编排：拼提示词 → 调补全 → 解析 → 去重 → 入库。"""

    def __init__(
        self,
        store: MemoryStore,
        profile_store: ProfileStore,
        *,
        complete: CompleteFn,
        prompt: str,
        similarity_threshold: float = SIMILARITY_THRESHOLD,
        is_forgotten: Callable[[str], bool] | None = None,
    ) -> None:
        """
        - ``complete``：注入的补全回调（application 用对话 provider 实现）；
        - ``prompt``：专用提示词全文（application 从 llm/prompts 加载后注入）；
        - ``similarity_threshold``：去重阈值（字符 bigram Dice，向量接入后换余弦）；
        - ``is_forgotten``：记忆本"遗忘名单"过滤器（application 注入，memory 域
          不 import notebook 域）。返回 True 的待入库记忆直接跳过——用户已经
          明确删掉的链接/路径，不能后台从旧对话里又捞回来。
        """
        self._store = store
        self._profile = profile_store
        self._complete = complete
        self._prompt = prompt
        self._threshold = similarity_threshold
        self._is_forgotten = is_forgotten

    async def extract(self, messages: Sequence[MessageLike]) -> ExtractionResult:
        """从对话记录中提取记忆并入库；LLM/解析异常均不抛出（后台任务安全）。"""
        transcript = format_transcript(messages)
        if not transcript:
            return ExtractionResult(ok=True, note="无对话内容，跳过")

        prompt = f"{self._prompt}\n\n---\n\n## 对话记录\n\n{transcript}"
        try:
            raw = await self._complete(prompt)
        except Exception as exc:  # LlmError / 注入实现任意异常：记日志并按失败返回
            # exc 文本可能来自第三方 SDK——shared.secrets.redact 已在日志脱敏链路兜底
            logger.warning("记忆提取失败（调用模型出错）：{}", exc)
            return ExtractionResult(ok=False, note="LLM 调用失败")

        extracted, profiles = parse_extraction(raw or "")
        return self._apply(extracted, profiles)

    # ---------- 内部 ----------

    def _apply(
        self,
        extracted: list[ExtractedMemory],
        profiles: list[ExtractedProfile],
    ) -> ExtractionResult:
        """遗忘过滤 + 去重 + 入库 + 画像更新。"""
        added: list[Memory] = []
        duplicates = 0
        forgotten = 0
        batch_texts: list[str] = []
        for item in extracted:
            if self._is_forgotten is not None and self._is_forgotten(item.text):
                forgotten += 1  # 用户在记忆本里明确删掉过的值（链接/路径等）
                continue
            if self._store.find_similar(item.text, threshold=self._threshold) is not None:
                duplicates += 1
                continue
            if any(similarity(item.text, text) >= self._threshold for text in batch_texts):
                duplicates += 1  # 同一批输出内部重复
                continue
            added.append(self._store.add(item.text, item.kind, item.importance))
            batch_texts.append(item.text)

        profile_keys: list[str] = []
        for profile in profiles:
            self._profile.set(profile.key, profile.value)
            profile_keys.append(profile.key)

        result = ExtractionResult(
            ok=True,
            added=added,
            duplicates=duplicates,
            forgotten=forgotten,
            profile_keys=profile_keys,
        )
        logger.info(
            "记忆提取完成：新增 {} 条 / 跳过重复 {} 条 / 跳过已遗忘 {} 条 / 画像更新 {} 项",
            len(added),
            duplicates,
            forgotten,
            len(profile_keys),
        )
        for memory in added:
            logger.debug("新增记忆 [{}] importance={:.2f}：{}", memory.kind, memory.importance, memory.text)
        for key in profile_keys:
            logger.debug("画像更新：{}", key)
        return result
