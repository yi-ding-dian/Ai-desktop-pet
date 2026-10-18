"""记忆后台服务（application 层编排，§7.1 时序结尾）。

职责：会话**空闲**（默认 5 分钟，可配）后触发记忆提取——
周期扫描所有已装载会话，对"空闲且自上次提取后有新消息"的会话调用
``modules/memory/extractor.MemoryExtractor``：

    读最近对话（从 messages 表，超出内存态轮数上限的部分也能拿到）
      → 拼提示词 + 调对话模型（非流式收集）
      → 解析 / 去重 / 入库（memories + profile）

设计要点：
- LLM 能力以 ``complete`` 回调注入 extractor（memory 域不 import llm 域）；
- 提取失败（LLM 报错/输出不合规）：记日志、**水位照常推进**——避免每个扫描
  周期反复重试白烧 token；对话原文仍在 messages 表中，将来可手动重提；
- ``extract_now(session)``：手动触发入口（调试/测试/未来"记忆管理页"按钮）；
- 后台循环吞掉所有异常（除取消）：后台任务不能因单次失败而退出。
"""

from __future__ import annotations

import asyncio
import functools
import time
from typing import Callable

from loguru import logger

from backend.application.session import Session, SessionManager
from backend.modules.chat.history import HistoryStore
from backend.modules.llm.prompts import load_memory_extract_prompt
from backend.modules.llm.provider import ChatMessage, LLMProvider
from backend.modules.memory.extractor import (
    TRANSCRIPT_MAX_MESSAGES,
    ExtractionResult,
    MemoryExtractor,
)
from backend.modules.memory.profile import ProfileStore
from backend.modules.memory.store import MemoryStore
from backend.shared.config import MemoryConfig

#: 提取调用参数（低温保证 JSON 稳定；推理型模型思考也消耗 token，给足额度）
COMPLETE_TEMPERATURE = 0.2
COMPLETE_MAX_TOKENS = 1024


def _now_ms() -> int:
    return int(time.time() * 1000)


async def complete_via_provider(provider: LLMProvider, prompt: str) -> str:
    """非流式补全：收集对话模型的流式输出成全文（注入给 extractor 的回调）。"""
    parts: list[str] = []
    async for chunk in provider.stream_chat(
        [ChatMessage(role="user", content=prompt)],
        temperature=COMPLETE_TEMPERATURE,
        max_tokens=COMPLETE_MAX_TOKENS,
    ):
        parts.append(chunk.text)
    return "".join(parts)


class MemoryService:
    """空闲检测 + 记忆提取的后台服务。"""

    def __init__(
        self,
        *,
        provider: LLMProvider,
        store: MemoryStore,
        profile_store: ProfileStore,
        sessions: SessionManager,
        history: HistoryStore | None = None,
        idle_seconds: float = 300.0,
        check_interval_seconds: float = 15.0,
        prompt: str | None = None,
        is_forgotten: Callable[[str], bool] | None = None,
    ) -> None:
        """
        - ``idle_seconds``：会话空闲多久后触发提取（默认 5 分钟，config [memory] 可配）；
        - ``check_interval_seconds``：扫描周期；
        - ``history``：从 messages 表读取比内存 deque 更长的对话片段（推荐传入）；
        - ``prompt``：提取提示词（缺省从 llm/prompts 加载；测试可注入简版）；
        - ``is_forgotten``：记忆本遗忘名单过滤器（application 装配注入；记忆域
          不 import notebook 域）。命中则这条待入库记忆跳过。
        """
        self._sessions = sessions
        self._history = history
        self._idle_seconds = max(1.0, float(idle_seconds))
        self._check_interval = max(0.5, float(check_interval_seconds))
        self._extractor = MemoryExtractor(
            store,
            profile_store,
            complete=functools.partial(complete_via_provider, provider),
            prompt=prompt if prompt is not None else load_memory_extract_prompt(),
            is_forgotten=is_forgotten,
        )
        self._task: asyncio.Task[None] | None = None

    # ---------- 生命周期 ----------

    def start(self) -> None:
        """启动后台扫描循环（幂等）。"""
        if self._task is not None and not self._task.done():
            return
        self._task = asyncio.create_task(self._loop(), name="memory-extract-loop")
        logger.info(
            "记忆提取服务启动：空闲阈值 {}s，扫描周期 {}s",
            self._idle_seconds,
            self._check_interval,
        )

    async def stop(self) -> None:
        """停止后台循环（进程退出/测试收尾）。"""
        task, self._task = self._task, None
        if task is None or task.done():
            return
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)

    async def update_config(self, config: MemoryConfig) -> None:
        """热更新配置（设置面板保存后由装配层调用，§7.6.3）。

        - ``enabled`` 开关：启动 / 停止后台扫描循环（启动幂等）；
        - ``idle_seconds`` / ``check_interval_seconds``：扫描循环的 sleep 与空闲
          判定都在每轮动态读这两个实例字段，换值即生效（无需重建服务）；
        - 对话模型（provider）经装配层的热替换引用跟随更新，此处无需感知。
        """
        self._idle_seconds = max(1.0, float(config.idle_seconds))
        self._check_interval = max(0.5, float(config.check_interval_seconds))
        if config.enabled:
            self.start()  # 幂等：循环已在跑则原样返回
            return
        await self.stop()
        logger.info("记忆提取服务配置更新：已停用（enabled=false）")

    # ---------- 提取 ----------

    async def _loop(self) -> None:
        while True:
            await asyncio.sleep(self._check_interval)
            try:
                await self.extract_idle()
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception("记忆提取扫描异常（已跳过本轮）")

    async def extract_idle(self) -> list[tuple[str, ExtractionResult]]:
        """扫描全部已装载会话，对到期的空闲会话执行提取；返回 (session_id, 结果)。"""
        now = _now_ms()
        results: list[tuple[str, ExtractionResult]] = []
        for session in self._sessions.all_sessions():
            if not self._is_idle(session, now):
                continue
            results.append((session.id, await self.extract_now(session)))
        return results

    def _is_idle(self, session: Session, now: int) -> bool:
        """到期判定：空闲超过阈值，且上次提取之后又有新消息。"""
        idle_ms = self._idle_seconds * 1000
        return (now - session.last_active_at) >= idle_ms and (
            session.last_active_at > session.last_extracted_at
        )

    async def extract_now(self, session: Session) -> ExtractionResult:
        """立即对指定会话执行一次提取（手动触发入口）。

        水位推进规则：无论成败都推进到"启动提取时的活跃时间快照"——
        提取期间新到的消息（last_active_at 已更大）留待下一轮，不会漏；
        失败推进则避免反复重试（详见模块 docstring）。
        """
        snapshot = session.last_active_at
        messages = self._load_messages(session)
        if not messages:
            session.last_extracted_at = max(session.last_extracted_at, snapshot)
            return ExtractionResult(ok=True, note="无对话消息，跳过")

        logger.info("触发记忆提取 session={} 消息数={}", session.id, len(messages))
        result = await self._extractor.extract(messages)
        session.last_extracted_at = max(session.last_extracted_at, snapshot)
        if not result.ok:
            logger.warning("记忆提取未成功 session={}（{}）", session.id, result.note)
        return result

    # ---------- 内部 ----------

    def _load_messages(self, session: Session) -> list[ChatMessage]:
        """取待提取的对话：优先从 messages 表读（更长），退化到内存态历史。"""
        if self._history is not None:
            rows = self._history.recent_messages(session.id, limit=TRANSCRIPT_MAX_MESSAGES)
            return [ChatMessage(role=row["role"], content=row["content"]) for row in rows]
        return session.recent_messages()
