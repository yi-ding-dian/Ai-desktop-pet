"""提醒功能 v1 单测：时间校验 / 重复规则 / 存储 / 调度补报 / 工具入口。

覆盖（2026-10-18）：
- parse_due_at：合法 ISO、无偏移按本地解释、过去时间、格式错误、超远时间；
- next_occurrence / advance_past：daily / weekdays / weekly（周末跳过）；
- ReminderStore：创建 / 列表排序 / 取消（id 与关键词）/ 标记 fired / 重排；
- ReminderService：到点送达、一次性只发一次、重复滚动、错过太久跳过、
  未送达重试、max_catchup 限流、late 标记、免打扰 silent 只气泡不出声；
- 工具入口：create/list/cancel 的成功与失败文案（供 chat_pipeline notice）。
"""

from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace

import pytest
from starlette.websockets import WebSocketState

from backend.application.reminder_service import (
    REPEAT_MISS_GRACE,
    ReminderDelivery,
    ReminderDeliveryItem,
    ReminderService,
)
from backend.application.voice import VoiceOut
from backend.interfaces.ws.dispatcher import _ReminderSink
from fakes import FakeTTSProvider
from backend.modules.reminders import (
    ReminderError,
    ReminderStore,
    advance_past,
    format_due,
    next_occurrence,
    parse_due_at,
)
from backend.shared.config import ReminderConfig
from backend.shared.db import connect_db

TZ = timezone(timedelta(hours=8))
NOW = datetime(2026, 10, 18, 9, 0, tzinfo=TZ)


def iso(value: datetime) -> str:
    return value.isoformat(timespec="seconds")


@pytest.fixture()
def store(tmp_path: Path) -> ReminderStore:
    return ReminderStore(connect_db(tmp_path / "pet.db"))


class FakeSink:
    """提醒下行替身：记录 delivery，可切换是否送达/连接是否关闭。"""

    def __init__(self, *, ok: bool = True) -> None:
        self.ok = ok
        self.closed = False
        self.deliveries: list[ReminderDelivery] = []

    def is_closed(self) -> bool:
        return self.closed

    async def deliver(self, delivery: ReminderDelivery) -> bool:
        self.deliveries.append(delivery)
        return self.ok


def make_service(
    store: ReminderStore,
    *,
    config: ReminderConfig | None = None,
    quiet_hours: list[str] | None = None,
) -> ReminderService:
    return ReminderService(
        store,
        config=lambda: config or ReminderConfig(),
        quiet_hours=lambda: quiet_hours or [],
        now=lambda: NOW,
    )


def tick(service: ReminderService, now: datetime | None = None) -> int:
    return asyncio.run(service.tick_once(now=now))


# ---------------------------------------------------------------- 时间校验


def test_parse_due_at_accepts_iso_with_offset() -> None:
    due = parse_due_at("2026-10-18T09:30:00+08:00", NOW)
    assert due == datetime(2026, 10, 18, 9, 30, tzinfo=TZ)


def test_parse_due_at_naive_treated_as_local() -> None:
    """模型漏了偏移：按本地时区解释，而不是报错（宽容 + 明确）。"""
    due = parse_due_at("2026-10-18 09:30", NOW)
    assert due.utcoffset() == timedelta(hours=8)
    assert due.hour == 9 and due.minute == 30


def test_parse_due_at_accepts_z_suffix() -> None:
    due = parse_due_at("2026-10-18T01:30:00Z", NOW)
    assert due.astimezone(TZ).hour == 9


@pytest.mark.parametrize(
    ("raw", "fragment"),
    [
        ("", "不能为空"),
        ("2026-10-18 08:59", "必须晚于现在"),
        ("不是时间", "格式看不懂"),
        ("2032-01-01T09:00:00+08:00", "太远"),
    ],
)
def test_parse_due_at_rejects_invalid(raw: str, fragment: str) -> None:
    with pytest.raises(ReminderError, match=fragment):
        parse_due_at(raw, NOW)


# ---------------------------------------------------------------- 重复规则


def test_next_occurrence_daily_weekly_weekdays() -> None:
    assert next_occurrence(NOW, "daily") == NOW + timedelta(days=1)
    assert next_occurrence(NOW, "weekly") == NOW + timedelta(days=7)
    # 2026-10-18 是周日 → 工作日下一跳是周一
    assert next_occurrence(NOW, "weekdays") == datetime(2026, 10, 19, 9, 0, tzinfo=TZ)
    # 周五 → 下一跳周一（跳过周末）
    friday = datetime(2026, 10, 23, 9, 0, tzinfo=TZ)
    assert next_occurrence(friday, "weekdays") == datetime(2026, 10, 26, 9, 0, tzinfo=TZ)


def test_next_occurrence_none_for_one_shot() -> None:
    assert next_occurrence(NOW, "none") is None
    assert next_occurrence(NOW, None) is None


def test_advance_past_rolls_to_future() -> None:
    later = NOW + timedelta(days=3, hours=1)
    assert advance_past(NOW, "daily", later) == NOW + timedelta(days=4)
    assert advance_past(NOW, "weekly", later) == NOW + timedelta(days=7)


def test_format_due_today_tomorrow_date() -> None:
    assert format_due(NOW + timedelta(minutes=30), NOW).startswith("今天 09:30")
    assert format_due(NOW + timedelta(days=1), NOW).startswith("明天 09:00")
    assert format_due(NOW + timedelta(days=2), NOW).startswith("后天 09:00")
    assert "10月25日" in format_due(NOW + timedelta(days=7), NOW)


# ---------------------------------------------------------------- 存储


def test_store_create_and_list_order(store: ReminderStore) -> None:
    later = store.create("交房租", iso(NOW + timedelta(days=1)), now=NOW)
    soon = store.create("关火", iso(NOW + timedelta(minutes=5)), now=NOW)
    items = store.list_active()
    assert [item.id for item in items] == [soon.id, later.id]
    assert soon.status == "scheduled"
    assert later.repeat_rule == "none"


@pytest.mark.parametrize(
    ("text", "fragment"),
    [("", "内容不能为空"), ("x" * 201, "太长")],
)
def test_store_rejects_bad_text(store: ReminderStore, text: str, fragment: str) -> None:
    with pytest.raises(ReminderError, match=fragment):
        store.create(text, iso(NOW + timedelta(minutes=5)), now=NOW)


def test_store_rejects_unknown_repeat(store: ReminderStore) -> None:
    with pytest.raises(ReminderError, match="重复规则"):
        store.create("喝水", iso(NOW + timedelta(minutes=5)), repeat_rule="hourly", now=NOW)


def test_store_cancel_by_id_and_keyword(store: ReminderStore) -> None:
    first = store.create("交房租", iso(NOW + timedelta(days=1)), now=NOW)
    second = store.create("喝水", iso(NOW + timedelta(minutes=30)), now=NOW)

    assert store.cancel(first.id) is not None
    assert store.get(first.id).status == "cancelled"  # type: ignore[union-attr]
    cancelled = store.cancel("喝")
    assert cancelled is not None and cancelled.id == second.id
    assert store.cancel("不存在") is None


def test_store_mark_fired_and_reschedule(store: ReminderStore) -> None:
    item = store.create("交房租", iso(NOW + timedelta(minutes=5)), now=NOW)
    store.mark_fired(item.id, now=NOW)
    fired = store.get(item.id)
    assert fired is not None and fired.status == "fired" and fired.fired_at is not None
    assert store.list_active() == []

    repeated = store.create(
        "喝水", iso(NOW + timedelta(minutes=5)), repeat_rule="daily", now=NOW
    )
    store.reschedule(repeated.id, NOW + timedelta(days=1))
    moved = store.get(repeated.id)
    assert moved is not None and moved.due_datetime == NOW + timedelta(days=1)


# ---------------------------------------------------------------- 调度


def test_tick_delivers_one_shot_and_marks_fired(store: ReminderStore) -> None:
    reminder = store.create("关火", iso(NOW + timedelta(minutes=1)), now=NOW)
    service = make_service(store)
    sink = FakeSink()
    service.set_connection(sink)

    assert tick(service,now=NOW + timedelta(minutes=1, seconds=1)) == 1
    assert len(sink.deliveries) == 1
    delivery = sink.deliveries[0]
    assert delivery.items[0].reminder_id == reminder.id
    assert delivery.text == "⏰ 提醒：关火"
    assert delivery.voice is False  # 默认关闭语音，但气泡消息一定送达
    assert delivery.late is False
    assert store.get(reminder.id).status == "fired"  # type: ignore[union-attr]
    # 再 tick 不会重复发送
    assert tick(service,now=NOW + timedelta(minutes=2)) == 0


def test_tick_marks_late_for_overdue_one_shot(store: ReminderStore) -> None:
    store.create("关火", iso(NOW + timedelta(minutes=1)), now=NOW)
    service = make_service(store)
    sink = FakeSink()
    service.set_connection(sink)

    tick(service,now=NOW + timedelta(minutes=10))
    assert sink.deliveries[0].late is True
    assert sink.deliveries[0].text.startswith("⏰ 补报提醒：")


def test_tick_repeats_and_rolls_to_next(store: ReminderStore) -> None:
    reminder = store.create(
        "喝水", iso(NOW + timedelta(minutes=1)), repeat_rule="daily", now=NOW
    )
    service = make_service(store)
    sink = FakeSink()
    service.set_connection(sink)

    assert tick(service,now=NOW + timedelta(minutes=1, seconds=1)) == 1
    moved = store.get(reminder.id)
    assert moved is not None
    assert moved.status == "scheduled"
    assert moved.due_datetime == NOW + timedelta(days=1, minutes=1)


def test_tick_skips_long_missed_repeat_without_delivery(store: ReminderStore) -> None:
    reminder = store.create(
        "喝水", iso(NOW + timedelta(minutes=1)), repeat_rule="daily", now=NOW
    )
    service = make_service(store)
    sink = FakeSink()
    service.set_connection(sink)

    late = NOW + timedelta(minutes=1) + REPEAT_MISS_GRACE + timedelta(seconds=1)
    assert tick(service,now=late) == 0
    assert sink.deliveries == []
    moved = store.get(reminder.id)
    assert moved is not None
    assert moved.status == "scheduled" and moved.due_datetime > late


def test_tick_keeps_reminder_when_delivery_fails(store: ReminderStore) -> None:
    reminder = store.create("关火", iso(NOW + timedelta(minutes=1)), now=NOW)
    service = make_service(store)
    sink = FakeSink(ok=False)
    service.set_connection(sink)

    assert tick(service,now=NOW + timedelta(minutes=1, seconds=1)) == 0
    assert len(sink.deliveries) == 1
    assert store.get(reminder.id).status == "scheduled"  # type: ignore[union-attr]


def test_concurrent_ticks_do_not_duplicate_delivery(store: ReminderStore) -> None:
    """立即补报与周期 tick 并发时串行化：同一条提醒只送达一次。"""
    store.create("关火", iso(NOW + timedelta(minutes=1)), now=NOW)
    service = make_service(store)
    sink = FakeSink()
    service.set_connection(sink)
    at = NOW + timedelta(minutes=1, seconds=1)

    async def scenario() -> list[int]:
        return await asyncio.gather(
            service.tick_once(now=at),
            service.tick_once(now=at),
        )

    results = asyncio.run(scenario())
    assert sum(results) == 1
    assert len(sink.deliveries) == 1


def test_tick_without_connection_does_nothing(store: ReminderStore) -> None:
    store.create("关火", iso(NOW + timedelta(minutes=1)), now=NOW)
    service = make_service(store)
    assert tick(service,now=NOW + timedelta(minutes=2)) == 0
    assert len(store.list_active()) == 1


def test_tick_respects_max_catchup(store: ReminderStore) -> None:
    for index in range(5):
        store.create(
            f"事情{index}", iso(NOW + timedelta(minutes=1)), now=NOW
        )
    service = make_service(store, config=ReminderConfig(max_catchup=3))
    sink = FakeSink()
    service.set_connection(sink)

    assert tick(service,now=NOW + timedelta(minutes=2)) == 3
    assert len(store.list_active()) == 2


def test_tick_batches_simultaneous_reminders_into_one_list(store: ReminderStore) -> None:
    """同一 tick 到期的多条合并成一条 proactive：气泡列全部，事件逐条未读。"""
    reminders = [
        store.create(text, iso(NOW + timedelta(minutes=1)), now=NOW)
        for text in ("关火", "交房租", "喝水")
    ]
    service = make_service(store)
    sink = FakeSink()
    service.set_connection(sink)

    delivered = tick(service, now=NOW + timedelta(minutes=1, seconds=1))

    assert delivered == 3
    assert len(sink.deliveries) == 1
    batch = sink.deliveries[0]
    assert batch.batch_id.startswith("b_")
    assert len(batch.items) == 3
    assert batch.text.startswith("⏰ 你有 3 条提醒")
    assert "1. " in batch.text and "2. " in batch.text and "3. " in batch.text
    assert "关火" in batch.text and "交房租" in batch.text and "喝水" in batch.text
    assert [item.late for item in batch.items] == [False, False, False]

    snapshot = service.list_unread()
    assert snapshot["unread_count"] == 3
    assert {item["id"] for item in snapshot["items"]} == {
        item.event_id for item in batch.items
    }
    assert all(store.get(reminder.id).status == "fired" for reminder in reminders)  # type: ignore[union-attr]
    assert store.list_active() == []


def test_unread_snapshot_and_acknowledge(store: ReminderStore) -> None:
    """未读快照按事件返回；按 id 已读与全部已读都生效。"""
    for text in ("关火", "喝水"):
        store.create(text, iso(NOW + timedelta(minutes=1)), now=NOW)
    service = make_service(store)
    sink = FakeSink()
    service.set_connection(sink)
    tick(service, now=NOW + timedelta(minutes=1, seconds=1))

    snapshot = service.list_unread()
    assert snapshot["unread_count"] == 2
    ids = [item["id"] for item in snapshot["items"]]
    assert all(item["time_text"] for item in snapshot["items"])

    updated = service.acknowledge(ids[:1])
    assert updated["unread_count"] == 1
    assert [item["id"] for item in updated["items"]] == [ids[1]]

    cleared = service.acknowledge(all_=True)
    assert cleared == {
        "items": [],
        "unread_count": 0,
        "pending": [],
        "pending_count": 0,
    }


def test_delete_item_removes_event_or_pending_plan(store: ReminderStore) -> None:
    """时钟视图红 ×：事件删除后未读清零；计划删除后 pending 清零。"""
    store.create("关火", iso(NOW + timedelta(minutes=1)), now=NOW)
    service = make_service(store)
    sink = FakeSink()
    service.set_connection(sink)
    tick(service, now=NOW + timedelta(minutes=1, seconds=1))

    event = service.list_unread()["items"][0]
    deleted_event = service.delete_item(event["id"])
    assert deleted_event["ok"] is True
    assert deleted_event["code"] == "reminder_event_deleted"
    assert store.get_event(event["id"]) is None
    assert service.list_unread()["unread_count"] == 0

    pending = store.create("明天交房租", iso(NOW + timedelta(days=1)), now=NOW)
    deleted_plan = service.delete_item(pending.id)
    assert deleted_plan["ok"] is True
    assert deleted_plan["code"] == "reminder_deleted"
    assert store.get(pending.id) is None
    assert service.list_unread()["pending_count"] == 0

    missing = service.delete_item("not-exists")
    assert missing["ok"] is False
    assert missing["code"] == "reminder_not_found"


def test_history_includes_read_and_unread_for_the_day(store: ReminderStore) -> None:
    """今日视图：已读 + 未读都返回，按触发时间正序；跨天事件不混入。"""
    reminders = [
        store.create(text, iso(NOW + timedelta(minutes=1)), now=NOW)
        for text in ("关火", "喝水")
    ]
    service = make_service(store)
    sink = FakeSink()
    service.set_connection(sink)
    tick(service, now=NOW + timedelta(minutes=1, seconds=1))

    snapshot = service.list_unread()
    first_id = snapshot["items"][0]["id"]
    service.acknowledge([first_id])

    history = service.list_history(NOW.date().isoformat())
    assert history["date"] == NOW.date().isoformat()
    assert len(history["items"]) == 2
    assert history["read_count"] == 1
    assert history["unread_count"] == 1
    assert [item["fired_at"] for item in history["items"]] == sorted(
        item["fired_at"] for item in history["items"]
    )
    assert sum(1 for item in history["items"] if item["acknowledged"]) == 1

    # 再插一条昨天触发的事件（直接写事件，不经过 tick）；标记 fired，
    # 避免它作为“未到期计划”出现在新视图里（pending 有单独用例覆盖）
    other = store.create("昨天的事", iso(NOW + timedelta(days=1)), now=NOW)
    store.record_event(
        other,
        event_id=store.new_event_id(),
        batch_id="b_yesterday",
        fired_at=NOW - timedelta(days=1),
        late=False,
    )
    store.mark_fired(other.id, now=NOW)
    today = service.list_history(NOW.date().isoformat())
    assert len(today["items"]) == 2  # 昨天的没混进来
    assert all(item["reminder_id"] != other.id for item in today["items"])


def test_history_includes_pending_reminders_with_gray_flag(store: ReminderStore) -> None:
    """时钟入口视图：当天事件 + 所有未到期计划，按 due_at 正序，pending 灰灯。"""
    store.create("关火", iso(NOW + timedelta(minutes=1)), now=NOW)
    service = make_service(store)
    sink = FakeSink()
    service.set_connection(sink)
    tick(service, now=NOW + timedelta(minutes=1, seconds=1))

    later_today = store.create(
        "下午喝水", iso(NOW + timedelta(hours=3)), now=NOW
    )
    tomorrow = store.create(
        "明天交房租", iso(NOW + timedelta(days=1)), now=NOW
    )

    history = service.list_history(NOW.date().isoformat())
    assert history["read_count"] == 0
    assert history["unread_count"] == 1
    assert history["pending_count"] == 2
    pending = [item for item in history["items"] if item["pending"]]
    assert [item["id"] for item in pending] == [later_today.id, tomorrow.id]
    assert pending[0]["time_text"].startswith("今天 12:00")
    assert pending[1]["time_text"].startswith("明天 09:00")

    dues = [datetime.fromisoformat(item["due_at"]) for item in history["items"]]
    assert dues == sorted(dues)

    snapshot = service.list_unread()
    assert snapshot["pending_count"] == 2
    assert [item["id"] for item in snapshot["pending"]] == [
        later_today.id,
        tomorrow.id,
    ]
    assert all(item["pending"] for item in snapshot["pending"])
    assert all(not item["pending"] for item in snapshot["items"])


def test_tick_silent_quiet_hours_disables_voice_but_keeps_bubble(store: ReminderStore) -> None:
    store.create("关火", iso(NOW + timedelta(minutes=1)), now=NOW)
    service = make_service(
        store,
        config=ReminderConfig(voice=True, quiet_hours_policy="silent"),
        quiet_hours=["09:00-10:00"],
    )
    sink = FakeSink()
    service.set_connection(sink)

    tick(service,now=NOW + timedelta(minutes=1, seconds=1))
    delivery = sink.deliveries[0]
    assert delivery.voice is False  # 免打扰静音
    assert delivery.text  # 气泡内容仍在


def test_tick_voice_follows_config_and_global_toggle(store: ReminderStore) -> None:
    store.create("关火", iso(NOW + timedelta(minutes=1)), now=NOW)
    service = make_service(store, config=ReminderConfig(voice=True))
    sink = FakeSink()
    service.set_connection(sink)

    tick(service,now=NOW + timedelta(minutes=1, seconds=1))
    assert sink.deliveries[0].voice is True


# ---------------------------------------------------------------- 工具入口


def test_tool_create_success_and_failure(store: ReminderStore) -> None:
    service = make_service(store)
    ok = service.create_from_tool(
        text="交房租", due_at=iso(NOW + timedelta(days=1)), repeat="none"
    )
    assert ok["ok"] is True and ok["code"] == "reminder_created"
    assert ok["message"].startswith("已设置提醒 · 明天 09:00 · 交房租")

    bad = service.create_from_tool(text="", due_at=iso(NOW), repeat="none")
    assert bad["ok"] is False and bad["code"] == "reminder_error"
    assert bad["message"].startswith("提醒没设上：")


def test_tool_list_and_cancel(store: ReminderStore) -> None:
    service = make_service(store)
    assert "还没有" in service.list_for_tool()["message"]

    service.create_from_tool(
        text="喝水", due_at=iso(NOW + timedelta(minutes=30)), repeat="daily"
    )
    listed = service.list_for_tool()
    assert listed["ok"] is True and "喝水" in listed["message"]

    cancelled = service.cancel_from_tool(key="喝水")
    assert cancelled["ok"] is True and cancelled["code"] == "reminder_cancelled"
    assert "已取消提醒" in cancelled["message"]

    missing = service.cancel_from_tool(key="不存在")
    assert missing["ok"] is False and missing["code"] == "reminder_not_found"


# ---------------------------------------------------------------- WS 下行适配（_ReminderSink）


class FakeCtx:
    """ConnectionContext 替身：记录文本事件与二进制音频帧。"""

    def __init__(self, *, voice: VoiceOut | None = None) -> None:
        self.ws = SimpleNamespace(client_state=WebSocketState.CONNECTED)
        self.voice = voice
        self.sent: list[tuple[str, dict]] = []
        self.frames: list[bytes] = []
        self.errors: list[tuple[str, str]] = []

    async def send_event(self, msg_type: str, data: dict | None = None, **_: object) -> None:
        self.sent.append((msg_type, data or {}))

    async def send_binary(self, frame: bytes) -> None:
        self.frames.append(frame)

    async def error(self, code: str, message: str) -> None:
        self.errors.append((code, message))


def delivery(*, voice: bool = False) -> ReminderDelivery:
    return ReminderDelivery(
        message_id="r_test_1",
        batch_id="b_test_1",
        text="⏰ 提醒：关火",
        spoken_text="提醒你：关火",
        emotion="surprised",
        late=False,
        voice=voice,
        items=(
            ReminderDeliveryItem(
                event_id="e_test_1",
                reminder_id="rem_test",
                text="关火",
                due_at=iso(NOW),
                late=False,
            ),
        ),
    )


def test_reminder_sink_always_sends_proactive_even_without_voice() -> None:
    """语音关闭（默认）：气泡事件照发，没有音频帧。"""
    ctx = FakeCtx()
    ok = asyncio.run(_ReminderSink(ctx).deliver(delivery(voice=False)))

    assert ok is True
    assert [msg_type for msg_type, _ in ctx.sent] == ["proactive"]
    payload = ctx.sent[0][1]
    assert payload["kind"] == "reminder"
    assert payload["text"] == "⏰ 提醒：关火"
    assert payload["batch_id"] == "b_test_1"
    assert payload["items"][0]["id"] == "e_test_1"
    assert payload["reminder_id"] == "rem_test"  # 兼容旧字段：批次第一项
    assert ctx.frames == []


def test_reminder_sink_voice_adds_audio_frames_after_proactive() -> None:
    """语音开启：proactive 之后合成并推送音频帧（气泡与语音互不替代）。"""
    tts = FakeTTSProvider()
    ctx = FakeCtx(voice=VoiceOut(tts))
    ok = asyncio.run(_ReminderSink(ctx).deliver(delivery(voice=True)))

    assert ok is True
    assert ctx.sent[0][0] == "proactive"
    assert tts.calls == ["提醒你：关火"]
    assert len(ctx.frames) == 1  # 一句话一帧
