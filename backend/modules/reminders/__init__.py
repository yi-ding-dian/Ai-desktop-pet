"""提醒域（2026-10-18）：提醒的校验、重复规则与 SQLite 存储。

领域边界：本域只回答"提醒是什么、什么时候下次"并负责持久化；定时调度、主动推送、
语音播报在 ``application/reminder_service.py``——本域不 import application / interfaces。
"""

from backend.modules.reminders.store import (
    REPEAT_RULES,
    Reminder,
    ReminderError,
    ReminderEvent,
    ReminderStore,
    advance_past,
    describe_repeat,
    format_confirmation,
    format_due,
    format_list_item,
    next_occurrence,
    parse_due_at,
)

__all__ = [
    "REPEAT_RULES",
    "Reminder",
    "ReminderError",
    "ReminderEvent",
    "ReminderStore",
    "advance_past",
    "describe_repeat",
    "format_confirmation",
    "format_due",
    "format_list_item",
    "next_occurrence",
    "parse_due_at",
]
