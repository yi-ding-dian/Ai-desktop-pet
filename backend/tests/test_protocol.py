"""interfaces/ws/protocol.py 单测：信封序列化/反序列化、版本校验、错误分支。"""

from __future__ import annotations

import json

import pytest

from backend.interfaces.ws.protocol import (
    CLIENT_EVENT_MODELS,
    SERVER_EVENT_MODELS,
    PROTOCOL_VERSION,
    HelloData,
    UserMessageData,
    make_envelope,
    parse_client_message,
    serialize_envelope,
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
    "user_message": {"text": "hi"},
    "ping": {},
    "interrupt": {},
    "pet_event": {"kind": "tap_head"},
    "get_config": {},
    "set_config": {"patch": {}},
    "test_llm": {"base_url": "https://api.example.com/v1", "model": "m"},
    "load_history": {"session_id": "s1"},
    "behavior_done": {"id": "b1"},
    "env_update": {},
    "audio_chunk": {},
}

SERVER_MIN_DATA: dict[str, dict] = {
    "hello_ack": {"ok": True},
    "state": {"state": "idle"},
    "behavior": {"id": "b1", "name": "walk"},
    "reply_start": {"message_id": "m1"},
    "token": {"message_id": "m1", "text": "a"},
    "sentence": {"message_id": "m1", "index": 0, "text": "a"},
    "emotion": {"message_id": "m1", "emotion": "happy", "intensity": 1.0},
    "audio": {},
    "reply_end": {"message_id": "m1", "full_text": "a"},
    "proactive": {"message_id": "m1", "text": "hi"},
    "history": {"session_id": "s1"},
    "config": {},
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
