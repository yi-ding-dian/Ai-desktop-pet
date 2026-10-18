"""提醒的领域模型、时间校验与 SQLite 存储（提醒功能 v1）。

设计取舍（2026-10-18，方案见仓库根 `待做方案.md`）：
- 时间只存**本地 ISO 时间（含偏移）**：用户看到/说出的都是墙钟时间，
  改系统时区后按新时区解释，不做跨时区的"绝对时刻"换算；
- 重复规则只接受白名单 ``none / daily / weekdays / weekly``——不做 cron 解析，
  模型的自由发挥在落库前被收敛；
- SQL 只按 ``status`` 取候选，到期比较在 Python 里做（提醒量小；避免 ISO 字符串
  在不同偏移下字典序不可比的问题）；
- 文本 1–200 字、必须晚于当前时间至少 10 秒、不超过 5 年——错误信息直接给用户看。
"""

from __future__ import annotations

import sqlite3
import uuid
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta, timezone
from typing import Literal, Sequence

#: 合法重复规则（None / "none" 都表示一次性）
REPEAT_RULES: tuple[str, ...] = ("none", "daily", "weekdays", "weekly")
RepeatRule = Literal["none", "daily", "weekdays", "weekly"]

#: 提醒时间至少要比现在晚这么多（避免模型算出"刚刚过去"的时间）
MIN_LEAD = timedelta(seconds=10)
#: 提醒时间最远 5 年（防模型把 2026 写成 2062）
MAX_LEAD = timedelta(days=5 * 365)
#: 提醒文本长度上限（字）
MAX_TEXT_CHARS = 200

_WEEKDAY_NAMES = "一二三四五六日"


class ReminderError(Exception):
    """提醒参数/状态错误（message 可直接展示给用户）。"""

    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.message = message


@dataclass(frozen=True)
class Reminder:
    """一条提醒计划（与 reminders 表逐字段对应）。"""

    id: str
    text: str
    due_at: str
    repeat_rule: str | None
    status: str
    created_at: str
    fired_at: str | None
    session_id: str | None

    @property
    def due_datetime(self) -> datetime:
        """``due_at`` 的 datetime（带偏移；库中数据由本域写入，格式可控）。"""
        return datetime.fromisoformat(self.due_at)


@dataclass(frozen=True)
class ReminderEvent:
    """一次到点触发事件（与 reminder_events 表逐字段对应）。

    一张提醒计划可以触发多次（重复提醒），每次一条事件；提醒列表/未读状态都以事件为单位。
    """

    id: str
    reminder_id: str
    batch_id: str
    text: str
    due_at: str
    fired_at: str
    acknowledged_at: str | None
    late: bool

    @property
    def due_datetime(self) -> datetime:
        return datetime.fromisoformat(self.due_at)

    @property
    def fired_datetime(self) -> datetime:
        return datetime.fromisoformat(self.fired_at)

    @property
    def acknowledged(self) -> bool:
        return self.acknowledged_at is not None


def _now_local() -> datetime:
    """当前本地时间（带 tzinfo；不能用 naive datetime 与库中带偏移时间比较）。"""
    return datetime.now().astimezone()


def parse_due_at(raw: str, now: datetime | None = None) -> datetime:
    """校验并解析用户/模型给的提醒时间（本地 ISO，允许空格分隔、允许 Z）。

    - 无偏移 → 按本地时区解释；
    - 必须晚于 now + MIN_LEAD，且不超过 now + MAX_LEAD；
    - 失败抛 :class:`ReminderError`（message 面向用户）。
    """
    now = now or _now_local()
    text = (raw or "").strip()
    if not text:
        raise ReminderError("提醒时间不能为空")
    normalized = text[:-1] + "+00:00" if text.endswith(("Z", "z")) else text
    try:
        due = datetime.fromisoformat(normalized)
    except ValueError as exc:
        raise ReminderError(
            "提醒时间格式看不懂（需要 ISO 时间，如 2026-10-18T09:00:00+08:00）"
        ) from exc
    if due.tzinfo is None:
        due = due.replace(tzinfo=now.tzinfo or timezone.utc)
    due = due.astimezone(now.tzinfo or timezone.utc)
    if due < now + MIN_LEAD:
        raise ReminderError("提醒时间必须晚于现在（至少 10 秒后）")
    if due > now + MAX_LEAD:
        raise ReminderError("提醒时间太远了（最多 5 年内）")
    return due


def normalize_repeat(raw: str | None) -> str:
    """把重复规则收敛到白名单；空/None → ``none``，非法值抛 ReminderError。"""
    text = (raw or "none").strip().lower()
    if text in ("", "none", "once", "一次", "不重复"):
        return "none"
    if text not in REPEAT_RULES:
        raise ReminderError("重复规则只支持：none / daily / weekdays / weekly")
    return text


def next_occurrence(due: datetime, rule: str | None) -> datetime | None:
    """给定当前到期时间，返回**下一次**到期时间；一次性返回 None。

    - daily：+1 天；
    - weekly：+7 天；
    - weekdays：下一个工作日（跳过周六/周日）。
    偏移固定为原 due 的时区（本地墙钟时间保持不变）。
    """
    if rule in (None, "", "none"):
        return None
    if rule == "daily":
        return due + timedelta(days=1)
    if rule == "weekly":
        return due + timedelta(days=7)
    if rule == "weekdays":
        candidate = due + timedelta(days=1)
        while candidate.weekday() >= 5:  # 5=周六 6=周日
            candidate += timedelta(days=1)
        return candidate
    raise ReminderError(f"未知重复规则：{rule}")


def advance_past(due: datetime, rule: str | None, now: datetime) -> datetime:
    """把重复提醒从 due 起滚动到**严格晚于 now** 的下一次（用于错过很久后跳过）。"""
    candidate = due
    # 5 年上限 + 最长每周一次 → 最多 ~300 次；while 上限只是防坏数据死循环
    for _ in range(10_000):
        nxt = next_occurrence(candidate, rule)
        if nxt is None:
            raise ReminderError("一次性提醒没有下一次")
        candidate = nxt
        if candidate > now:
            return candidate
    raise ReminderError("重复规则滚动次数异常（请检查 due_at / repeat）")


def format_due(due: datetime, now: datetime | None = None) -> str:
    """把到期时间格式化成用户可读的短文案（今天/明天/日期 + 周几）。"""
    now = now or _now_local()
    local = due.astimezone(now.tzinfo or timezone.utc)
    delta_days = (local.date() - now.date()).days
    if delta_days == 0:
        day = "今天"
    elif delta_days == 1:
        day = "明天"
    elif delta_days == 2:
        day = "后天"
    elif local.year == now.year:
        day = f"{local.month}月{local.day}日（周{_WEEKDAY_NAMES[local.weekday()]}）"
    else:
        day = f"{local.year}年{local.month}月{local.day}日"
    return f"{day} {local:%H:%M}"


def describe_repeat(rule: str | None) -> str:
    """重复规则的用户文案（一次性返回空串）。"""
    return {
        "daily": "（每天）",
        "weekdays": "（工作日）",
        "weekly": "（每周）",
    }.get(rule or "none", "")


def format_confirmation(reminder: Reminder, now: datetime | None = None) -> str:
    """聊天区确定性确认文案：``已设置提醒 · 明天 09:00 · 交房租``。"""
    now = now or _now_local()
    return (
        f"已设置提醒 · {format_due(reminder.due_datetime, now)}"
        f"{describe_repeat(reminder.repeat_rule)} · {reminder.text}"
    )


def format_list_item(reminder: Reminder, now: datetime | None = None) -> str:
    """列表里的一条：``明天 09:00 交房租``。"""
    now = now or _now_local()
    return (
        f"{format_due(reminder.due_datetime, now)}"
        f"{describe_repeat(reminder.repeat_rule)} {reminder.text}"
    )


class ReminderStore:
    """reminders 表的同步访问（单事件循环内短语句，同 shared/db.py 的约定）。"""

    def __init__(self, conn: sqlite3.Connection) -> None:
        self._conn = conn

    # ---------------------------------------------------------------- 写

    def create(
        self,
        text: str,
        due_at: str,
        repeat_rule: str | None = "none",
        *,
        session_id: str | None = None,
        now: datetime | None = None,
    ) -> Reminder:
        """校验并落库一条提醒；参数不合法抛 :class:`ReminderError`。"""
        now = now or _now_local()
        content = (text or "").strip()
        if not content:
            raise ReminderError("提醒内容不能为空")
        if len(content) > MAX_TEXT_CHARS:
            raise ReminderError(f"提醒内容太长了（最多 {MAX_TEXT_CHARS} 字）")
        due = parse_due_at(due_at, now)
        rule = normalize_repeat(repeat_rule)
        reminder_id = f"r_{uuid.uuid4().hex[:10]}"
        created = _iso(now)
        self._conn.execute(
            """
            INSERT INTO reminders
              (id, text, due_at, repeat_rule, status, created_at, fired_at, session_id)
            VALUES (?, ?, ?, ?, 'scheduled', ?, NULL, ?)
            """,
            (reminder_id, content, _iso(due), rule, created, session_id),
        )
        reminder = self.get(reminder_id)
        if reminder is None:  # 理论上不可能；防御性兜底，避免返回 None 给上层
            raise ReminderError("提醒保存失败（写入后读取不到）")
        return reminder

    def mark_fired(self, reminder_id: str, *, now: datetime | None = None) -> None:
        """标记一次性提醒已送达（status=fired + fired_at）。"""
        self._conn.execute(
            "UPDATE reminders SET status='fired', fired_at=? WHERE id=?",
            (_iso(now or _now_local()), reminder_id),
        )

    def reschedule(self, reminder_id: str, due_at: datetime) -> None:
        """重复提醒滚动到下一次（状态保持 scheduled）。"""
        self._conn.execute(
            "UPDATE reminders SET due_at=? WHERE id=?",
            (_iso(due_at), reminder_id),
        )

    def cancel(self, key: str, *, now: datetime | None = None) -> Reminder | None:
        """取消一条未触发的提醒：``key`` 先按 id 精确匹配，再按文本包含匹配。

        多条文本命中时取最早到期的一条；找不到返回 None。
        """
        text = (key or "").strip()
        if not text:
            return None
        reminder = self.get(text)
        if reminder is None or reminder.status != "scheduled":
            candidates = [
                item
                for item in self.scheduled()
                if item.status == "scheduled" and text in item.text
            ]
            candidates.sort(key=lambda item: item.due_datetime)
            reminder = candidates[0] if candidates else None
        if reminder is None:
            return None
        self._conn.execute(
            "UPDATE reminders SET status='cancelled' WHERE id=?", (reminder.id,)
        )
        return self.get(reminder.id)

    # ---------------------------------------------------------------- 读

    def get(self, reminder_id: str) -> Reminder | None:
        row = self._conn.execute(
            "SELECT * FROM reminders WHERE id=?", (reminder_id,)
        ).fetchone()
        return _to_reminder(row) if row is not None else None

    def scheduled(self) -> list[Reminder]:
        """全部未触发的提醒（服务 tick 用；顺序由调用方按 due 排）。"""
        rows = self._conn.execute(
            "SELECT * FROM reminders WHERE status='scheduled'"
        ).fetchall()
        return [_to_reminder(row) for row in rows]

    def list_active(self, limit: int = 20) -> list[Reminder]:
        """未到期的提醒（按到期时间正序，列表工具用）。"""
        items = self.scheduled()
        items.sort(key=lambda item: item.due_datetime)
        return items[: max(1, limit)]

    # ---------------------------------------------------------------- 触发事件（未读列表）

    @staticmethod
    def new_event_id() -> str:
        """生成事件 id（服务在送达前要先把 id 放进 proactive，再落库）。"""
        return f"e_{uuid.uuid4().hex[:12]}"

    def record_event(
        self,
        reminder: Reminder,
        *,
        event_id: str,
        batch_id: str,
        fired_at: datetime,
        late: bool,
    ) -> ReminderEvent:
        """记录一次成功送达的提醒事件（未读；重复提醒每次触发各一条）。"""
        self._conn.execute(
            """
            INSERT INTO reminder_events
              (id, reminder_id, batch_id, text, due_at, fired_at, acknowledged_at, late)
            VALUES (?, ?, ?, ?, ?, ?, NULL, ?)
            """,
            (
                event_id,
                reminder.id,
                batch_id,
                reminder.text,
                reminder.due_at,
                _iso(fired_at),
                1 if late else 0,
            ),
        )
        event = self.get_event(event_id)
        if event is None:  # 防御性兜底（插入后读不到）
            raise ReminderError("提醒事件保存失败（写入后读取不到）")
        return event

    def get_event(self, event_id: str) -> ReminderEvent | None:
        row = self._conn.execute(
            "SELECT * FROM reminder_events WHERE id=?", (event_id,)
        ).fetchone()
        return _to_event(row) if row is not None else None

    def list_unread(self, limit: int = 50) -> list[ReminderEvent]:
        """未读事件（最新的在前；提醒列表用）。"""
        rows = self._conn.execute(
            "SELECT * FROM reminder_events WHERE acknowledged_at IS NULL "
            "ORDER BY fired_at DESC, id DESC LIMIT ?",
            (max(1, limit),),
        ).fetchall()
        return [_to_event(row) for row in rows]

    def count_unread(self) -> int:
        row = self._conn.execute(
            "SELECT COUNT(*) AS n FROM reminder_events WHERE acknowledged_at IS NULL"
        ).fetchone()
        return int(row["n"]) if row is not None else 0

    def list_for_day(self, day: date, *, now: datetime | None = None) -> list[ReminderEvent]:
        """某一天触发的事件（已读 + 未读，按触发时间正序）——提醒“今日”视图用。"""
        now = now or _now_local()
        tz = now.tzinfo or timezone.utc
        start = datetime.combine(day, time.min, tzinfo=tz)
        end = start + timedelta(days=1)
        rows = self._conn.execute(
            "SELECT * FROM reminder_events WHERE fired_at >= ? AND fired_at < ? "
            "ORDER BY fired_at ASC, id ASC",
            (_iso(start), _iso(end)),
        ).fetchall()
        # 偏移不同的历史数据兜底：按本地日期精确过滤
        return [
            event
            for event in (_to_event(row) for row in rows)
            if event.fired_datetime.astimezone(tz).date() == day
        ]

    def acknowledge(
        self,
        ids: Sequence[str] | None = None,
        *,
        all_: bool = False,
        now: datetime | None = None,
    ) -> int:
        """标记事件已读；``all_=True`` 清空全部未读。返回本次标记条数。"""
        stamp = _iso(now or _now_local())
        if all_:
            cursor = self._conn.execute(
                "UPDATE reminder_events SET acknowledged_at=? WHERE acknowledged_at IS NULL",
                (stamp,),
            )
            return int(cursor.rowcount or 0)
        cleaned = [str(item) for item in (ids or []) if str(item).strip()]
        if not cleaned:
            return 0
        placeholders = ",".join("?" for _ in cleaned)
        cursor = self._conn.execute(
            f"UPDATE reminder_events SET acknowledged_at=? "
            f"WHERE acknowledged_at IS NULL AND id IN ({placeholders})",
            (stamp, *cleaned),
        )
        return int(cursor.rowcount or 0)


def _iso(value: datetime) -> str:
    return value.isoformat(timespec="seconds")


def _to_reminder(row: sqlite3.Row) -> Reminder:
    return Reminder(
        id=str(row["id"]),
        text=str(row["text"]),
        due_at=str(row["due_at"]),
        repeat_rule=str(row["repeat_rule"]) if row["repeat_rule"] is not None else None,
        status=str(row["status"]),
        created_at=str(row["created_at"]),
        fired_at=str(row["fired_at"]) if row["fired_at"] is not None else None,
        session_id=str(row["session_id"]) if row["session_id"] is not None else None,
    )


def _to_event(row: sqlite3.Row) -> ReminderEvent:
    return ReminderEvent(
        id=str(row["id"]),
        reminder_id=str(row["reminder_id"]),
        batch_id=str(row["batch_id"]),
        text=str(row["text"]),
        due_at=str(row["due_at"]),
        fired_at=str(row["fired_at"]),
        acknowledged_at=(
            str(row["acknowledged_at"]) if row["acknowledged_at"] is not None else None
        ),
        late=bool(row["late"]),
    )
