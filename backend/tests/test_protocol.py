"""interfaces/ws/protocol.py 单测：信封序列化/反序列化、版本校验、错误分支、
二进制音频帧封装（§3.5，字节级断言）。"""

from __future__ import annotations

import json
import struct

import pytest

from backend.interfaces.ws.protocol import (
    AUDIO_SAMPLE_RATE,
    CLIENT_EVENT_MODELS,
    SERVER_EVENT_MODELS,
    PROTOCOL_VERSION,
    DeleteReminderItemData,
    HelloData,
    UserMessageData,
    make_audio_header,
    make_envelope,
    pack_audio_frame,
    parse_client_message,
    serialize_envelope,
    unpack_audio_frame,
)
from backend.shared.errors import ErrorCode, ProtocolError


def _raw(msg_type: str, data: object = None, **overrides: object) -> str:
    base = {
        "v": PROTOCOL_VERSION,
        "id": "t_1",
        "reply_to": None,
        "type": msg_type,
        "ts": 1,
        "data": data,
    }
    base.update(overrides)
    return json.dumps(base)


# ---------------------------------------------------------------- 序列化 / 反序列化


def test_roundtrip() -> None:
    env = make_envelope("user_message", {"text": "你好"})
    parsed = parse_client_message(serialize_envelope(env))
    assert parsed.envelope.type == "user_message"
    assert isinstance(parsed.data, UserMessageData)
    assert parsed.data.text == "你好"


def test_serialized_reply_to_is_null_and_version_preset() -> None:
    obj = json.loads(serialize_envelope(make_envelope("pong", {})))
    assert obj["v"] == PROTOCOL_VERSION
    assert "reply_to" in obj and obj["reply_to"] is None
    assert obj["type"] == "pong"


def test_serialized_data_from_pydantic_model() -> None:
    obj = json.loads(serialize_envelope(make_envelope("hello_ack", HelloData(token="x", protocol_version=1))))
    assert obj["data"]["token"] == "x"


def test_unknown_extra_envelope_field_ignored() -> None:
    parsed = parse_client_message(_raw("ping", {}, future_field=123))
    assert parsed.envelope.type == "ping"


def test_delete_reminder_item_client_event_is_registered() -> None:
    """新增客户端事件必须进 CLIENT_EVENT_MODELS，否则真机报 UNKNOWN_TYPE。"""
    parsed = parse_client_message(_raw("delete_reminder_item", {"id": "e_1"}))
    assert isinstance(parsed.data, DeleteReminderItemData)
    assert parsed.data.id == "e_1"


# ---------------------------------------------------------------- 错误分支


def test_bad_json_raises_bad_message() -> None:
    with pytest.raises(ProtocolError) as ei:
        parse_client_message("{not json")
    assert ei.value.code is ErrorCode.BAD_MESSAGE


def test_non_object_json_raises_bad_message() -> None:
    with pytest.raises(ProtocolError) as ei:
        parse_client_message("[1, 2, 3]")
    assert ei.value.code is ErrorCode.BAD_MESSAGE


def test_envelope_missing_id_raises_bad_message() -> None:
    with pytest.raises(ProtocolError) as ei:
        parse_client_message(json.dumps({"v": 1, "type": "ping", "data": {}}))
    assert ei.value.code is ErrorCode.BAD_MESSAGE


def test_unknown_event_type() -> None:
    with pytest.raises(ProtocolError) as ei:
        parse_client_message(_raw("no_such_event", {}))
    assert ei.value.code is ErrorCode.UNKNOWN_TYPE


def test_data_validation_failure() -> None:
    with pytest.raises(ProtocolError) as ei:
        parse_client_message(_raw("user_message", {}))  # 缺 text
    assert ei.value.code is ErrorCode.BAD_MESSAGE


def test_envelope_version_mismatch_is_fatal() -> None:
    with pytest.raises(ProtocolError) as ei:
        parse_client_message(_raw("ping", {}, v=2))
    assert ei.value.code is ErrorCode.VERSION_MISMATCH
    assert ei.value.fatal is True


def test_hello_missing_token() -> None:
    with pytest.raises(ProtocolError) as ei:
        parse_client_message(_raw("hello", {"protocol_version": 1}))
    assert ei.value.code is ErrorCode.BAD_MESSAGE


def test_hello_ok() -> None:
    msg = parse_client_message(
        _raw("hello", {"token": "secret", "protocol_version": 1, "app_version": "0.1.0"})
    )
    assert isinstance(msg.data, HelloData)
    assert msg.data.token == "secret"


def test_null_data_tolerated() -> None:
    # 客户端把 data 发成 null / 缺省：宽松处理为空对象
    assert parse_client_message(_raw("ping", None)).envelope.type == "ping"
    assert parse_client_message(json.dumps({"v": 1, "id": "x", "type": "ping"})).envelope.type == "ping"


# ---------------------------------------------------------------- 事件表完整性（§3.2/§3.3）


CLIENT_MIN_DATA: dict[str, dict] = {
    "hello": {"token": "t", "protocol_version": 1},
    "user_message": {"text": "hi", "attachments": [{"path": "/tmp/a.txt", "name": "a.txt"}]},
    "ping": {},
    "interrupt": {},
    "pet_event": {"kind": "tap_head"},
    "get_config": {},
    "set_config": {"patch": {}},
    "test_llm": {"base_url": "https://api.example.com/v1", "model": "m"},
    "get_profile": {},
    "note_assistant_message": {"text": "你好呀~你叫什么名字呢？"},
    "load_history": {"session_id": "s1"},
    "delete_message": {"id": 1},
    "behavior_done": {"id": "b1"},
    "env_update": {},
    "get_reminders": {"limit": 20},
    "ack_reminders": {"ids": ["e1"]},
    "get_reminder_history": {},
    "delete_reminder_item": {"id": "e1"},
    "memory_book_list": {"kind": "link"},
    "memory_book_save": {"items": [{"name": "博客", "kind": "link", "value": "https://a.com"}]},
    "memory_book_rename": {"old_name": "博客", "new_name": "主页"},
    "memory_book_delete": {"names": ["主页"]},
    "memory_book_file_deleted": {"path": "D:\\tmp\\a.txt"},
    "audio_chunk": {},
}

SERVER_MIN_DATA: dict[str, dict] = {
    "hello_ack": {"ok": True},
    "state": {"state": "idle"},
    "behavior": {"id": "b1", "name": "walk"},
    "reply_start": {"message_id": "m1"},
    "message_saved": {"client_id": "u1", "db_id": 1, "role": "user"},
    "message_deleted": {"id": 1, "ok": True},
    "reasoning": {"message_id": "m1", "text": "先想想…"},
    "token": {"message_id": "m1", "text": "a"},
    "sentence": {"message_id": "m1", "index": 0, "text": "a"},
    "emotion": {"message_id": "m1", "emotion": "happy", "intensity": 1.0},
    "audio": {},
    "reply_end": {"message_id": "m1", "full_text": "a"},
    "tool_call": {"id": "call_1", "name": "open_settings", "args": {}},
    "proactive": {"message_id": "m1", "text": "hi"},
    "reminders": {"items": [], "unread_count": 0},
    "reminder_history": {"date": "2026-10-18", "items": [], "read_count": 0, "unread_count": 0},
    "memory_book_items": {"items": [], "count": 0},
    "memory_book_result": {"ok": True, "code": "items_saved", "message": "记好啦"},
    "notice": {"code": "context_reset", "message": "为了装下文件，先不带之前的聊天了"},
    "sources": {
        "message_id": "m1",
        "items": [
            {
                "index": 1,
                "title": "新闻",
                "url": "https://example.com/a",
                "snippet": "摘要",
                "site_name": "央视网",
                "date": "2026/10/18",
            }
        ],
    },
    "history": {"session_id": "s1"},
    "config": {},
    "profile": {"has_name": False, "name": None, "memory_enabled": True},
    "llm_test_result": {"ok": True, "message": "连接成功"},
    "error": {"code": "X", "message": "y"},
    "pong": {},
}


def test_client_event_table_complete() -> None:
    assert set(CLIENT_EVENT_MODELS) == set(CLIENT_MIN_DATA)


def test_server_event_table_complete() -> None:
    assert set(SERVER_EVENT_MODELS) == set(SERVER_MIN_DATA)


def test_all_client_events_parse() -> None:
    for type_name, data in CLIENT_MIN_DATA.items():
        msg = parse_client_message(_raw(type_name, data))
        assert msg.envelope.type == type_name


def test_all_server_events_serializable() -> None:
    for type_name, data in SERVER_MIN_DATA.items():
        model_cls = SERVER_EVENT_MODELS[type_name]
        payload = model_cls.model_validate(data)
        obj = json.loads(serialize_envelope(make_envelope(type_name, payload)))
        assert obj["type"] == type_name


# ---------------------------------------------------------------- 工作模式单轮选项（2026-10-18）


def test_user_message_options_parsed() -> None:
    """单轮选项必须显式声明在 UserMessageData 上（EventData 默认忽略未知字段）。"""
    msg = parse_client_message(
        _raw(
            "user_message",
            {"text": "hi", "options": {"search": False}},
        )
    )
    data = msg.data
    assert isinstance(data, UserMessageData)
    assert data.options is not None
    assert data.options.search is False


def test_user_message_options_defaults_and_null() -> None:
    """不传 / null 都容忍：旧客户端行为不变（允许搜索）。"""
    absent = parse_client_message(_raw("user_message", {"text": "hi"}))
    assert isinstance(absent.data, UserMessageData)
    assert absent.data.options is None

    nulled = parse_client_message(_raw("user_message", {"text": "hi", "options": None}))
    assert isinstance(nulled.data, UserMessageData)
    assert nulled.data.options is None

    defaults = parse_client_message(
        _raw("user_message", {"text": "hi", "options": {}})
    )
    assert isinstance(defaults.data, UserMessageData)
    assert defaults.data.options is not None
    assert defaults.data.options.search is True


# ---------------------------------------------------------------- 二进制音频帧（§3.5）


def test_audio_header_fields_follow_design() -> None:
    """JSON 头字段与 §3.5 冻结格式一致。"""
    header = make_audio_header("m_abc", 2, final=True)
    assert header == {
        "type": "audio",
        "message_id": "m_abc",
        "seq": 2,
        "format": "mp3",
        "sample_rate": 24000,
        "final": True,
    }
    assert AUDIO_SAMPLE_RATE == 24000


def test_pack_audio_frame_byte_layout() -> None:
    """字节级断言：4 字节大端头长 + UTF-8 JSON 头 + 音频数据。"""
    header = make_audio_header("m_1", 0, final=False)
    payload = b"\xff\xf3\x64\xc4" + b"\xab" * 300
    frame = pack_audio_frame(header, payload)

    head_json = json.dumps(header, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    assert frame[:4] == struct.pack(">I", len(head_json))  # 大端 4 字节长度
    assert frame[:3] == b"\x00\x00\x00"  # 小长度时高位为 0（大端特征）
    assert frame[4 : 4 + len(head_json)] == head_json
    assert frame[4 + len(head_json) :] == payload  # body 原样拼接，无任何转码
    assert len(frame) == 4 + len(head_json) + len(payload)
    # 头长只需 1 字节的样本：验证不是小端打包（小端时 frame[:4]==b"\x5c\x00\x00\x00"）
    assert frame[0] == 0 and frame[3] == len(head_json)


def test_pack_audio_frame_roundtrip_with_unicode_header() -> None:
    """头里含非 ASCII 字符时按 UTF-8 编码（长度按字节计）。"""
    header = make_audio_header("m_2", 9, final=True) | {"note": "中文备注"}
    payload = b"\xff\xfb\x90\x64" * 10
    decoded, body = unpack_audio_frame(pack_audio_frame(header, payload))
    assert decoded == header
    assert body == payload


def test_unpack_empty_payload_ok() -> None:
    header = make_audio_header("m_3", 1, final=True)
    decoded, body = unpack_audio_frame(pack_audio_frame(header, b""))
    assert decoded["seq"] == 1
    assert body == b""


def test_unpack_rejects_malformed_frames() -> None:
    with pytest.raises(ValueError):
        unpack_audio_frame(b"\x00\x00")  # 不足 4 字节
    with pytest.raises(ValueError):
        unpack_audio_frame(struct.pack(">I", 99) + b"{short")  # 头长越界
    with pytest.raises(ValueError):
        unpack_audio_frame(struct.pack(">I", 3) + b"abc" + b"x")  # JSON 不可解析
    with pytest.raises(ValueError):
        unpack_audio_frame(struct.pack(">I", 2) + b"[]" + b"x")  # JSON 非对象
