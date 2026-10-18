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
import uuid
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from typing import Callable, Protocol, Sequence

from loguru import logger

from backend.modules.behavior import rules
from backend.modules.reminders import (
    Reminder,
    ReminderError,
    ReminderEvent,
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
class ReminderDeliveryItem:
    """一条已到点提醒（批量下行的单项；event_id 供前端已读/列表使用）。"""

    event_id: str
    reminder_id: str
    text: str
    due_at: str
    late: bool


@dataclass(frozen=True)
class ReminderDelivery:
    """一次到点提醒批次的下行载荷（同一 tick 的多条合并成一条 proactive）。

    ``items`` 顺序即展示顺序；``event_id`` 在送达成功后才落 reminder_events，
    前端拿它做"知道了"回执。
    """

    message_id: str
    batch_id: str
    text: str
    spoken_text: str
    emotion: str
    late: bool
    voice: bool
    items: tuple[ReminderDeliveryItem, ...]


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

    # ---------------------------------------------------------------- 未读列表（WS get/ack）

    def list_unread(self, limit: int = 50) -> dict:
        """未读提醒快照（前端列表/球标用）：最新在前，含用户可读时间文案。"""
        now = self._now()
        events = self._store.list_unread(max(1, min(100, limit)))
        return {
            "items": [self._event_payload(event, now) for event in events],
            "unread_count": self._store.count_unread(),
        }

    def acknowledge(self, ids: Sequence[str] | None = None, *, all_: bool = False) -> dict:
        """标记提醒已读（按事件 id / 全部），返回更新后的未读快照。"""
        count = self._store.acknowledge(ids, all_=all_, now=self._now())
        logger.info("提醒已读：{} 条（all={}）", count, all_)
        return self.list_unread()

    def list_history(self, day: str | None = None, limit: int = 200) -> dict:
        """某一天的全部提醒事件（已读 + 未读，按触发时间正序）——今日视图。"""
        now = self._now()
        day_value = now.date()
        if day:
            try:
                day_value = date.fromisoformat(day)
            except ValueError:
                logger.warning("提醒历史日期格式非法（{}），回退为今天", day)
        events = self._store.list_for_day(day_value, now=now)[
            : max(1, min(500, limit))
        ]
        read_count = sum(1 for event in events if event.acknowledged)
        return {
            "date": day_value.isoformat(),
            "items": [self._event_payload(event, now) for event in events],
            "read_count": read_count,
            "unread_count": len(events) - read_count,
        }

    @staticmethod
    def _event_payload(event: ReminderEvent, now: datetime) -> dict:
        return {
            "id": event.id,
            "reminder_id": event.reminder_id,
            "text": event.text,
            "due_at": event.due_at,
            "fired_at": event.fired_at,
            "late": event.late,
            "acknowledged": event.acknowledged,
            "time_text": format_due(event.due_datetime, now),
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

        # 同一 tick 到期的提醒合并成一个批次（一条 proactive 列全部）——避免多条同时到达时
        # 气泡互相覆盖、语音逐条轰炸（2026-10-18 用户定稿"全部显示，列出来"）。
        batch: list[tuple[Reminder, bool]] = []
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
            batch.append((reminder, overdue > LATE_THRESHOLD))
        if not batch:
            return 0

        batch_id = f"b_{uuid.uuid4().hex[:12]}"
        items = tuple(
            ReminderDeliveryItem(
                event_id=self._store.new_event_id(),
                reminder_id=reminder.id,
                text=reminder.text,
                due_at=reminder.due_at,
                late=late,
            )
            for reminder, late in batch
        )
        delivery = self._build_delivery(items, now, config, batch_id)
        ok = await sink.deliver(delivery)
        if not ok:
            logger.warning("提醒批次送达失败（连接已断开？），下轮重试：batch={}", batch_id)
            return 0

        # 送达成功后才落事件与推进状态：连接失败时整批保留，下轮重试不会产生未读脏数据。
        for (reminder, late), item in zip(batch, items):
            try:
                self._store.record_event(
                    reminder,
                    event_id=item.event_id,
                    batch_id=batch_id,
                    fired_at=now,
                    late=late,
                )
            except Exception:
                # 事件落库失败不回头重发（已展示过），只记日志——避免同一提醒无限重复推送
                logger.exception("提醒事件落库失败（提醒仍按已处理推进）：id={}", reminder.id)
            if self._is_repeating(reminder):
                next_due = advance_past(reminder.due_datetime, reminder.repeat_rule, now)
                self._store.reschedule(reminder.id, next_due)
            else:
                self._store.mark_fired(reminder.id, now=now)
        logger.info(
            "提醒批次已送达 batch={} 条数={} late={} voice={}",
            batch_id,
            len(batch),
            delivery.late,
            delivery.voice,
        )
        return len(batch)

    def _build_delivery(
        self,
        items: tuple[ReminderDeliveryItem, ...],
        now: datetime,
        config: ReminderConfig,
        batch_id: str,
    ) -> ReminderDelivery:
        """组装批量下行载荷：单条用短句，多条编号列出；语音合并成一句。"""
        if len(items) == 1:
            item = items[0]
            text = ("⏰ 补报提醒：" if item.late else "⏰ 提醒：") + item.text
            spoken = f"提醒你：{item.text}"
        else:
            lines = [f"⏰ 你有 {len(items)} 条提醒"]
            for index, item in enumerate(items, 1):
                due = datetime.fromisoformat(item.due_at)
                suffix = "（补报）" if item.late else ""
                lines.append(f"{index}. {format_due(due, now)} {item.text}{suffix}")
            text = "\n".join(lines)
            spoken = f"提醒你 {len(items)} 件事：" + "、".join(item.text for item in items)

        voice = config.voice and not (
            config.quiet_hours_policy == "silent" and self._in_quiet_hours(now)
        )
        return ReminderDelivery(
            message_id=f"r_{batch_id}",
            batch_id=batch_id,
            text=text,
            spoken_text=spoken,
            emotion="surprised",
            late=any(item.late for item in items),
            voice=voice,
            items=items,
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
