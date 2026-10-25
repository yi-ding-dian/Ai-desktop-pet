"""设置面板 WS 链路测试：dispatcher 三事件（get_config / set_config / test_llm）。

两层：
- 快测：轻量 ConnectionContext 替身 + 真 Dispatcher（handler 注册 / 回执 / 错误码）；
- e2e：真 uvicorn + websockets 客户端（hello 鉴权后的全链路，设置窗口的真实通道）。

隔离手法与 test_settings_service.py 一致（PET_DATA_DIR / keyring 原语 / 脱敏集合）。
"""

from __future__ import annotations

import asyncio
import json
import uuid
from pathlib import Path
from typing import Any

import pytest
import uvicorn
import websockets

from backend.application.chat_pipeline import ChatPipeline
from backend.application.runtime import Runtime
from backend.application.session import SessionManager
from backend.application.settings_service import SettingsService
from backend.interfaces.ws.dispatcher import build_dispatcher
from backend.interfaces.ws.protocol import parse_client_message
from backend.interfaces.ws.server import create_app
from backend.modules.llm.provider import ProbeResult
from backend.shared import secrets
from backend.shared.config import AppConfig, load_config
from fakes import EchoLLMProvider

TOKEN = "test-token-123"
RECV_TIMEOUT = 8.0


@pytest.fixture(autouse=True)
def _isolate(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("PET_DATA_DIR", str(tmp_path))
    monkeypatch.delenv(secrets.ENV_KEY_NAME, raising=False)
    monkeypatch.setattr(secrets, "_keyring_get", lambda: None)
    monkeypatch.setattr(secrets, "_keyring_set", lambda key: False)
    saved = set(secrets._known_secrets)
    yield tmp_path
    secrets._known_secrets.clear()
    secrets._known_secrets.update(saved)


class FakeCtx:
    """ConnectionContext 替身：记录出站事件与错误（不触碰真实 WebSocket）。"""

    def __init__(self) -> None:
        self.id = "c_test"
        self.authed = True
        self.session_id = "s_test"
        self.close_request: tuple[int, str] | None = None
        self.sent: list[tuple[str, dict[str, Any]]] = []
        self.errors: list[tuple[str, str]] = []

    async def send_event(
        self, msg_type: str, data: Any = None, *, reply_to: str | None = None
    ) -> None:
        self.sent.append((msg_type, data or {}))

    async def send_error(
        self, code: Any, message: str, *, fatal: bool = False, reply_to: str | None = None
    ) -> None:
        self.errors.append((str(code), message))

    def request_close(self, code: int, reason: str = "") -> None:
        self.close_request = (code, reason)


def make_dispatcher(*, with_settings: bool, probe: Any | None = None):
    """组装最小 dispatcher；with_settings=True 时接入真 SettingsService。"""
    runtime = Runtime(AppConfig())
    if probe is not None:
        runtime.llm.swap(probe)
    pipeline = ChatPipeline(provider=runtime.llm)
    settings = SettingsService(runtime=runtime) if with_settings else None
    dispatcher = build_dispatcher(
        pipeline=pipeline,
        sessions=SessionManager(),
        token=TOKEN,
        app_version="test",
        settings=settings,
    )
    return dispatcher, runtime


def raw(msg_type: str, data: dict) -> str:
    return json.dumps(
        {"v": 1, "id": f"t_{uuid.uuid4().hex[:8]}", "type": msg_type, "ts": 0, "data": data}
    )


async def dispatch(dispatcher, ctx: FakeCtx, msg_type: str, data: dict) -> None:
    await dispatcher.dispatch(ctx, parse_client_message(raw(msg_type, data)))


# ---------------------------------------------------------------- 注册与兜底


def test_settings_handlers_registered_only_when_configured() -> None:
    with_settings, _ = make_dispatcher(with_settings=True)
    assert with_settings.has("get_config")
    assert with_settings.has("set_config")
    assert with_settings.has("test_llm")

    without, _ = make_dispatcher(with_settings=False)
    assert not without.has("get_config")
    assert not without.has("test_llm")


def test_get_config_without_settings_falls_back_to_not_implemented() -> None:
    async def scenario() -> None:
        dispatcher, _ = make_dispatcher(with_settings=False)
        ctx = FakeCtx()
        await dispatch(dispatcher, ctx, "get_config", {})
        assert ctx.errors == [("NOT_IMPLEMENTED", "事件类型 get_config 尚未实现")]

    asyncio.run(scenario())


# ---------------------------------------------------------------- get_config / set_config


def test_get_config_pushes_masked_snapshot(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(secrets.ENV_KEY_NAME, "env-key-0123456789")

    async def scenario() -> None:
        dispatcher, _ = make_dispatcher(with_settings=True)
        ctx = FakeCtx()
        await dispatch(dispatcher, ctx, "get_config", {})

        assert len(ctx.sent) == 1
        msg_type, data = ctx.sent[0]
        assert msg_type == "config"
        assert data["llm"]["key"] == "env****6789"  # mask_secret：前 3 + **** + 后 4
        assert data["pet"]["name"] == "小兔"
        assert "env-key-0123456789" not in json.dumps(data, ensure_ascii=False)

    asyncio.run(scenario())


def test_set_config_invalid_pushes_config_invalid_error(tmp_path: Path) -> None:
    async def scenario() -> None:
        dispatcher, runtime = make_dispatcher(with_settings=True)
        ctx = FakeCtx()
        await dispatch(dispatcher, ctx, "set_config", {"patch": {"llm": {"base_url": "瞎写"}}})

        assert ctx.sent == []
        code, message = ctx.errors[0]
        assert code == "CONFIG_INVALID"
        assert "base_url" in message  # message 说明具体原因
        assert not (tmp_path / "config.toml").exists()  # 校验失败不落盘

    asyncio.run(scenario())


def test_set_config_agent_workspace_requires_existing_dir(tmp_path: Path) -> None:
    async def scenario() -> None:
        dispatcher, _ = make_dispatcher(with_settings=True)
        ctx = FakeCtx()
        missing = tmp_path / "nope"
        await dispatch(
            dispatcher,
            ctx,
            "set_config",
            {"patch": {"agent": {"default_workspace": str(missing)}}},
        )

        assert ctx.sent == []
        code, message = ctx.errors[0]
        assert code == "CONFIG_INVALID"
        assert "默认工作区" in message
        assert not (tmp_path / "config.toml").exists()

        workspace = tmp_path / "workspace"
        workspace.mkdir()
        ctx2 = FakeCtx()
        await dispatch(
            dispatcher,
            ctx2,
            "set_config",
            {"patch": {"agent": {"default_workspace": str(workspace)}}},
        )
        assert ctx2.errors == []
        assert load_config(tmp_path / "config.toml").agent.default_workspace == str(workspace)

    asyncio.run(scenario())


def test_set_config_success_pushes_config_reply(tmp_path: Path) -> None:
    async def scenario() -> None:
        dispatcher, runtime = make_dispatcher(with_settings=True)
        ctx = FakeCtx()
        await dispatch(
            dispatcher, ctx, "set_config", {"patch": {"pet": {"name": "毛豆"}}}
        )

        assert ctx.errors == []
        msg_type, data = ctx.sent[0]
        assert msg_type == "config"  # 新快照作回执
        assert data["pet"]["name"] == "毛豆"
        assert load_config(tmp_path / "config.toml").pet.name == "毛豆"

    asyncio.run(scenario())


# ---------------------------------------------------------------- test_llm


class FakeProbeProvider:
    def __init__(self, result: ProbeResult) -> None:
        self.result = result
        self.calls: list[dict[str, Any]] = []

    async def probe(self, **overrides: Any) -> ProbeResult:
        self.calls.append(overrides)
        return self.result


def test_test_llm_pushes_result_event() -> None:
    async def scenario() -> None:
        fake = FakeProbeProvider(
            ProbeResult(ok=True, message="连接成功（model=m1）", models=["m1", "m2"])
        )
        dispatcher, _ = make_dispatcher(with_settings=True, probe=fake)
        ctx = FakeCtx()
        await dispatch(
            dispatcher,
            ctx,
            "test_llm",
            {"base_url": "https://x/v1", "model": "m1", "key": "k-123"},
        )

        assert ctx.errors == []
        msg_type, data = ctx.sent[0]
        assert msg_type == "llm_test_result"
        assert data == {"ok": True, "message": "连接成功（model=m1）", "models": ["m1", "m2"]}
        assert fake.calls == [{"base_url": "https://x/v1", "model": "m1", "api_key": "k-123"}]

    asyncio.run(scenario())


def test_test_llm_accepts_empty_data_and_reports_failure() -> None:
    """{base_url, model, key?} 全缺省（用当前配置）也合法；失败给出具体原因。"""

    async def scenario() -> None:
        fake = FakeProbeProvider(ProbeResult(ok=False, message="无法连接 LLM 服务"))
        dispatcher, _ = make_dispatcher(with_settings=True, probe=fake)
        ctx = FakeCtx()
        await dispatch(dispatcher, ctx, "test_llm", {})

        msg_type, data = ctx.sent[0]
        assert msg_type == "llm_test_result"
        assert data == {"ok": False, "message": "无法连接 LLM 服务"}
        assert "models" not in data

    asyncio.run(scenario())


# ---------------------------------------------------------------- e2e（真 uvicorn）


async def start_server() -> tuple[uvicorn.Server, asyncio.Task, int]:
    runtime = Runtime(AppConfig())
    pipeline = ChatPipeline(provider=EchoLLMProvider())
    dispatcher = build_dispatcher(
        pipeline=pipeline,
        sessions=SessionManager(),
        token=TOKEN,
        app_version="test",
        settings=SettingsService(runtime=runtime),
    )
    app = create_app(
        dispatcher=dispatcher, app_version="test", voice_factory=runtime.voice_factory
    )
    config = uvicorn.Config(
        app,
        host="127.0.0.1",
        port=0,
        log_config=None,
        log_level="warning",
        access_log=False,
        lifespan="off",
    )
    server = uvicorn.Server(config)
    task = asyncio.create_task(server.serve())
    while not server.started:
        if task.done():
            await task
        await asyncio.sleep(0.01)
    port = int(server.servers[0].sockets[0].getsockname()[1])
    return server, task, port


def test_settings_flow_over_real_ws(tmp_path: Path) -> None:
    """设置窗口自持 WS 连接的真实链路：hello → get_config → set_config → 回执。"""

    async def scenario() -> None:
        server, task, port = await start_server()
        try:
            async with websockets.connect(f"ws://127.0.0.1:{port}/ws") as ws:
                await ws.send(
                    json.dumps(
                        {
                            "v": 1,
                            "id": "h1",
                            "type": "hello",
                            "data": {"token": TOKEN, "protocol_version": 1},
                        }
                    )
                )
                ack = json.loads(await asyncio.wait_for(ws.recv(), timeout=RECV_TIMEOUT))
                assert ack["type"] == "hello_ack" and ack["data"]["ok"] is True

                await ws.send(raw("get_config", {}))
                got = json.loads(await asyncio.wait_for(ws.recv(), timeout=RECV_TIMEOUT))
                assert got["type"] == "config"
                assert got["data"]["pet"]["name"] == "小兔"

                await ws.send(raw("set_config", {"patch": {"pet": {"name": "云朵"}}}))
                got = json.loads(await asyncio.wait_for(ws.recv(), timeout=RECV_TIMEOUT))
                assert got["type"] == "config"
                assert got["data"]["pet"]["name"] == "云朵"
        finally:
            server.should_exit = True
            await task

        assert load_config(tmp_path / "config.toml").pet.name == "云朵"

    asyncio.run(scenario())
