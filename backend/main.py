"""后端入口：装配依赖 → 程序化启动 uvicorn（动态端口）→ 打印 PET_READY 握手行。

启动握手（设计文档 §3.4）：
1. Electron 通过环境变量传入 PET_TOKEN / PET_DATA_DIR；
2. 本进程绑定 127.0.0.1 的系统分配端口（bind 0）；
3. uvicorn 就绪后向 stdout 打印独立一行：
       PET_READY {"port": <实际端口>, "pid": <pid>}
4. 开发模式（未传 PET_TOKEN）：自动生成随机 token 并加入 READY 行的 "token" 字段，
   供独立自测；传了 PET_TOKEN 时 READY 行不含 token。

启动方式（项目根目录，禁止 reload）：
    backend/.venv/bin/python -m backend.main
"""

from __future__ import annotations

import asyncio
import json
import os
import secrets
import sys

import uvicorn
from loguru import logger

from backend import __version__
from backend.application.chat_pipeline import ChatPipeline, EchoLLMProvider
from backend.application.session import SessionManager
from backend.interfaces.ws.dispatcher import build_dispatcher
from backend.interfaces.ws.server import create_app
from backend.shared.config import load_config
from backend.shared.logging import setup_logging

HOST = "127.0.0.1"
READY_PREFIX = "PET_READY "


def main() -> int:
    """进程主入口。"""
    token = (os.environ.get("PET_TOKEN") or "").strip()
    dev_mode = not token
    if dev_mode:
        # 开发模式：未传 PET_TOKEN，自产随机 token 并随 READY 行下发，便于独立自测
        token = secrets.token_urlsafe(32)

    setup_logging(level=os.environ.get("PET_LOG_LEVEL", "INFO"))
    logger.info("启动后端（{}模式）", "开发" if dev_mode else "生产")

    # 加载配置：文件不存在时在 PET_DATA_DIR 生成默认模板（§6.3）
    app_config = load_config()
    logger.info("配置已加载：llm.model={} pet.name={}", app_config.llm.model, app_config.pet.name)

    sessions = SessionManager()
    pipeline = ChatPipeline(provider=EchoLLMProvider())
    dispatcher = build_dispatcher(
        pipeline=pipeline, sessions=sessions, token=token, app_version=__version__
    )
    app = create_app(dispatcher=dispatcher, app_version=__version__)

    config = uvicorn.Config(
        app,
        host=HOST,
        port=0,  # bind 0：由系统分配空闲端口（§3.4 步骤 1）
        log_config=None,  # 不接管 logging，避免干扰 stdout 握手行
        log_level="warning",
        access_log=False,
        lifespan="off",
    )
    server = uvicorn.Server(config)
    try:
        asyncio.run(_serve(server, token=token, dev_mode=dev_mode))
    except KeyboardInterrupt:  # 兜底：正常退出码约定
        return 130
    return 0


async def _serve(server: uvicorn.Server, *, token: str, dev_mode: bool) -> None:
    """启动 uvicorn，就绪后打印 READY 行，然后等待退出信号（SIGINT/SIGTERM）。"""
    serve_task = asyncio.create_task(server.serve(), name="uvicorn-serve")
    while not server.started:
        if serve_task.done():
            await serve_task  # 启动失败：让其异常向外传播
            raise RuntimeError("uvicorn 在完成启动前退出")
        await asyncio.sleep(0.02)

    port = _bound_port(server)
    emit_ready(port, token=token if dev_mode else None)
    await serve_task


def _bound_port(server: uvicorn.Server) -> int:
    """从 uvicorn 实际绑定的 socket 读取系统分配的端口。"""
    servers = getattr(server, "servers", None) or []
    for srv in servers:
        for sock in getattr(srv, "sockets", None) or []:
            return int(sock.getsockname()[1])
    single = getattr(server, "server", None)  # 兼容旧版 uvicorn 属性名
    if single is not None:
        for sock in getattr(single, "sockets", None) or []:
            return int(sock.getsockname()[1])
    raise RuntimeError("无法从 uvicorn 获取实际绑定端口")


def emit_ready(port: int, *, token: str | None = None) -> None:
    """向 stdout 打印握手行（独立一行、立即 flush，供逐行解析）。"""
    payload: dict[str, object] = {"port": port, "pid": os.getpid()}
    if token:
        payload["token"] = token
    sys.stdout.write(READY_PREFIX + json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()
    logger.info("后端就绪 127.0.0.1:{} pid={}", port, os.getpid())


if __name__ == "__main__":
    raise SystemExit(main())
