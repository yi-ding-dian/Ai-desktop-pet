"""提醒调度服务（2026-10-18，提醒功能 v1）。

职责：
- 每 10 秒检查一次到期提醒（**不用长定时器**：休眠、改系统时间、应用重启后
  都能自然补上）；
- 到点经 ``ReminderSink`` 主动推 ``proactive`` 事件（+ 可选 TTS）给宠物连接；
- 一次性提醒送达后标记 fired；重复提醒滚动到下一次；
- 错过的提醒：一次性补报（late=true）；重复错过超过 5 分钟直接滚到下一次，
  避免开机时把几个月的历史提醒逐条播出来；
- 未送达（无连接 / 发送失败）不标记，下一 tick 重试。

分层：本模块属 application——依赖 modules/reminders（领域逻辑）、modules/behavior
（免打扰时段）与 shared/config；**不 import interfaces**。WS 推送由 dispatcher
里的 ``_ReminderSink`` 适配（连接归属/语音帧都在那层）。
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Callable, Protocol

from loguru import logger

from backend.modules.behavior import rules
from backend.modules.reminders import (
    Reminder,
    ReminderError,
    ReminderStore,
    advance_past,
    format_confirmation,
    format_due,
    format_list_item,
)
from backend.shared.config import ReminderConfig

#: 到期检查周期（秒）：10s 对"分钟级提醒"足够，且休眠恢复后最多晚 10s
TICK_SECONDS = 10.0
#: 超过到期时间多久算"错过了"（气泡上标注补报；只是提示口径，不影响送达）
LATE_THRESHOLD = timedelta(seconds=30)
#: 重复提醒错过超过这个时长就跳过（滚到下一次，不补历史）
REPEAT_MISS_GRACE = timedelta(minutes=5)


@dataclass(frozen=True)
class ReminderDelivery:
    """一次到点提醒的下行载荷（由 interfaces 层转成 proactive 事件 + 音频帧）。"""

    message_id: str
    text: str
    spoken_text: str
    emotion: str
    reminder_id: str
    due_at: str
    late: bool
    voice: bool


class ReminderSink(Protocol):
    """提醒下行端口（dispatcher 适配；is_closed 用于跳过已断开的连接）。"""

    def is_closed(self) -> bool: ...

    async def deliver(self, delivery: ReminderDelivery) -> bool:
        """推送到宠物连接；返回是否送达（False → 不标记 fired，下轮重试）。"""
        ...


class ReminderService:
    """提醒调度服务（全局单例，由 Runtime 装配并启停）。"""

    def __init__(
        self,
        store: ReminderStore,
        *,
        config: Callable[[], ReminderConfig] | None = None,
        quiet_hours: Callable[[], list[str]] | None = None,
        tick_seconds: float = TICK_SECONDS,
        now: Callable[[], datetime] | None = None,
    ) -> None:
        """
        - ``store``：提醒存储（同一 pet.db）；
        - ``config``：当前提醒配置的活引用（设置保存后下一 tick 即生效）；
        - ``quiet_hours``：免打扰时段活引用（复用 ``[behavior].quiet_hours``）；
        - ``now``：时钟注入点（测试用；缺省本地带时区时间）。
        """
        self._store = store
        self._config = config or (lambda: self._static_config)
        self._static_config = ReminderConfig()
        self._quiet_hours = quiet_hours or (lambda: [])
        self._tick_seconds = tick_seconds
        self._now = now or (lambda: datetime.now().astimezone())

        self._sink: ReminderSink | None = None
        self._running = False
        self._task: asyncio.Task[None] | None = None
        #: tick 串行锁：连接建立时的即时补报与 10s 周期 tick 可能并发，
        #: 不串行会让同一条到期提醒被两次读到 → 重复推送（2026-10-18）。
        self._tick_lock = asyncio.Lock()

    # ---------------------------------------------------------------- 装配

    @property
    def store(self) -> ReminderStore:
        return self._store

    def set_connection(self, sink: ReminderSink | None) -> None:
        """绑定宠物连接（dispatcher 在 hello 且 client_role=pet 时调用）。

        绑定后立刻补一次 tick：应用重启/断线重连后尽快补报，不必等满 10 秒。
        """
        self._sink = sink
        if sink is None:
            return
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:  # 非事件循环线程（测试装配）——由调用方自行 tick
            return
        loop.create_task(self._tick_safe(), name="reminders-catchup")

    def start(self) -> None:
        """启动调度循环（配置关闭时自判不启动）。"""
        if self._task is not None:
            return
        if not self._config().enabled:
            logger.info("提醒服务未启用（config [reminders].enabled=false）")
            return
        self._running = True
        self._task = asyncio.get_running_loop().create_task(
            self._run_loop(), name="reminder-service"
        )
        logger.info("提醒服务启动：检查周期 {:.0f}s", self._tick_seconds)

    async def stop(self) -> None:
        """停止调度循环（幂等）。"""
        self._running = False
        task = self._task
        self._task = None
        if task is None:
            return
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass
        except Exception:  # 收尾异常不应影响退出
            logger.exception("提醒服务任务收尾异常")

    async def update_config(self, config: ReminderConfig) -> None:
        """配置热更新：enabled 联动启停（其余字段每 tick 动态读）。"""
        self._static_config = config
        if not config.enabled:
            await self.stop()
            logger.info("提醒服务配置更新：已停用")
            return
        if self._task is None or self._task.done():
            self.start()

    # ---------------------------------------------------------------- 工具入口（backend 型工具 handler）

    def create_from_tool(self, *, text: str, due_at: str, repeat: str) -> dict:
        """``create_reminder`` 工具实现：校验 → 落库 → 返回聊天区确认文案。"""
        now = self._now()
        try:
            reminder = self._store.create(
                text=text, due_at=due_at, repeat_rule=repeat, now=now
            )
        except ReminderError as exc:
            logger.info("创建提醒被拒：{}", exc.message)
            return {"ok": False, "code": "reminder_error", "message": f"提醒没设上：{exc.message}"}
        except Exception:
            logger.exception("创建提醒失败（存储异常）")
            return {
                "ok": False,
                "code": "reminder_error",
                "message": "提醒没设上：保存时出了点问题，再试一次好吗？",
            }
        message = format_confirmation(reminder, now)
        logger.info("已创建提醒 id={} due={} repeat={}", reminder.id, reminder.due_at, reminder.repeat_rule)
        return {
            "ok": True,
            "code": "reminder_created",
            "message": message,
            "reminder_id": reminder.id,
        }

    def list_for_tool(self, limit: int = 20) -> dict:
        """``list_reminders`` 工具实现：未触发的提醒按到期时间列出。"""
        now = self._now()
        items = self._store.list_active(limit)
        if not items:
            return {
                "ok": True,
                "code": "reminders_listed",
                "message": "现在还没有待触发的提醒～",
            }
        shown = "；".join(
            f"{index}. {format_list_item(item, now)}" for index, item in enumerate(items, 1)
        )
        return {
            "ok": True,
            "code": "reminders_listed",
            "message": f"你有 {len(items)} 条提醒：{shown}",
        }

    def cancel_from_tool(self, *, key: str) -> dict:
        """``cancel_reminder`` 工具实现：按 id / 文本关键词取消一条未触发提醒。"""
        now = self._now()
        try:
            reminder = self._store.cancel(key, now=now)
        except Exception:
            logger.exception("取消提醒失败（存储异常）")
            return {
                "ok": False,
                "code": "reminder_error",
                "message": "取消提醒时出了点问题，再试一次好吗？",
            }
        if reminder is None:
            return {
                "ok": False,
                "code": "reminder_not_found",
                "message": "没有找到这条提醒～ 可以说说提醒内容里的关键词吗？",
            }
        return {
            "ok": True,
            "code": "reminder_cancelled",
            "message": f"已取消提醒 · {format_due(reminder.due_datetime, now)} · {reminder.text}",
            "reminder_id": reminder.id,
        }

    # ---------------------------------------------------------------- 调度

    async def tick_once(self, now: datetime | None = None) -> int:
        """检查并送达一轮到期提醒；返回本轮成功送达条数（测试直接调用）。

        串行化：立即补报与周期 tick 共用同一把锁，避免并发读到同一条提醒。
        """
        async with self._tick_lock:
            return await self._tick_locked(now)

    async def _tick_locked(self, now: datetime | None = None) -> int:
        config = self._config()
        if not config.enabled:
            return 0
        sink = self._sink
        if sink is None or sink.is_closed():
            return 0

        now = now or self._now()
        due = [item for item in self._store.scheduled() if item.due_datetime <= now]
        due.sort(key=lambda item: item.due_datetime)

        delivered = 0
        for reminder in due[: max(1, config.max_catchup)]:
            overdue = now - reminder.due_datetime
            if self._is_repeating(reminder) and overdue > REPEAT_MISS_GRACE:
                # 重复提醒错过太久：不补历史，直接滚到下一次
                next_due = advance_past(reminder.due_datetime, reminder.repeat_rule, now)
                self._store.reschedule(reminder.id, next_due)
                logger.info(
                    "重复提醒错过太久，已滚到下一次：id={} {}=>{}",
                    reminder.id,
                    reminder.due_at,
                    next_due.isoformat(timespec="seconds"),
                )
                continue

            delivery = self._build_delivery(reminder, now, overdue, config)
            ok = await sink.deliver(delivery)
            if not ok:
                logger.warning("提醒送达失败（连接已断开？），下轮重试：id={}", reminder.id)
                break
            if self._is_repeating(reminder):
                next_due = advance_past(reminder.due_datetime, reminder.repeat_rule, now)
                self._store.reschedule(reminder.id, next_due)
            else:
                self._store.mark_fired(reminder.id, now=now)
            delivered += 1
            logger.info(
                "提醒已送达 id={} 字数={} late={} voice={}",
                reminder.id,
                len(reminder.text),
                delivery.late,
                delivery.voice,
            )
        return delivered

    def _build_delivery(
        self,
        reminder: Reminder,
        now: datetime,
        overdue: timedelta,
        config: ReminderConfig,
    ) -> ReminderDelivery:
        """组装下行载荷：补报时给气泡加前缀；免打扰 silent 策略下不出声。"""
        late = overdue > LATE_THRESHOLD
        prefix = "⏰ 补报提醒：" if late else "⏰ 提醒："
        voice = config.voice and not (
            config.quiet_hours_policy == "silent" and self._in_quiet_hours(now)
        )
        return ReminderDelivery(
            message_id=f"r_{reminder.id}_{int(now.timestamp())}",
            text=f"{prefix}{reminder.text}",
            spoken_text=f"提醒你：{reminder.text}",
            emotion="surprised",
            reminder_id=reminder.id,
            due_at=reminder.due_at,
            late=late,
            voice=voice,
        )

    def _in_quiet_hours(self, now: datetime) -> bool:
        try:
            return rules.in_quiet_hours(now, self._quiet_hours())
        except ValueError:  # 配置校验已挡；防御手改配置的坏值
            logger.warning("免打扰时段解析失败，按非免打扰处理")
            return False

    @staticmethod
    def _is_repeating(reminder: Reminder) -> bool:
        return reminder.repeat_rule not in (None, "", "none")

    async def _run_loop(self) -> None:
        logger.info("提醒服务循环进入")
        try:
            while self._running:
                await self._tick_safe()
                await asyncio.sleep(self._tick_seconds)
        except asyncio.CancelledError:
            raise
        finally:
            logger.info("提醒服务循环退出")

    async def _tick_safe(self) -> None:
        """单轮 tick 兜底：任何异常都不允许终止服务循环。"""
        try:
            await self.tick_once()
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("提醒检查失败（本轮跳过，下轮继续）")
