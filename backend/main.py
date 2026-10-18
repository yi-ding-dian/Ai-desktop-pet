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
from backend.application.chat_pipeline import ChatPipeline
from backend.application.memory_service import MemoryService
from backend.application.notebook_service import NotebookService
from backend.application.runtime import Runtime
from backend.application.session import SessionManager
from backend.application.settings_service import SettingsService
from backend.interfaces.ws.dispatcher import build_dispatcher
from backend.interfaces.ws.server import create_app
from backend.modules.behavior import BehaviorEngine
from backend.modules.chat.history import HistoryStore
from backend.modules.memory.profile import ProfileStore
from backend.modules.memory.store import MemoryStore
from backend.modules.notebook import NotebookStore
from backend.modules.reminders import ReminderStore
from backend.shared.config import load_config
from backend.shared.db import connect_db, get_db_path
from backend.shared.logging import setup_logging
from backend.shared.secrets import get_llm_key, mask_secret

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

    # SQLite（§6.2）：会话历史 + 长期记忆 + 画像统一落在 PET_DATA_DIR/pet.db
    db_path = get_db_path()
    conn = connect_db(db_path)
    history_store = HistoryStore(conn)
    memory_store = MemoryStore(conn)
    profile_store = ProfileStore(conn)
    reminder_store = ReminderStore(conn)
    notebook_store = NotebookStore(conn)
    notebook_store.purge_expired_forgotten()  # 清理过期的遗忘名单（30 天 TTL）
    # 记忆本用例（2026-10-18）：保存/改名/删记录 + 打开/删文件前解析；
    # 删除真实文件由 Electron 主进程在用户确认后移入回收站（本服务不删文件）。
    notebook_service = NotebookService(notebook_store, memory_store)
    logger.info("数据库就绪：{}", db_path)

    # 会话管理由 HistoryStore 支撑：进程重启后 load_history 可回填、历史不丢
    sessions = SessionManager(store=history_store)

    # 运行时可重装配控制面（§7.6.3）：设置面板保存配置后由 Runtime 热更各模块；
    # LLM provider 经可热替换的槽（LlmSlot）被流水线/记忆提取/测试连接共享，
    # base_url/model/采样参数热更、key 经读取链惰性获取（keyring 更新即时生效）
    runtime = Runtime(
        app_config, reminder_store=reminder_store, notebook=notebook_service
    )
    logger.info(
        "LLM 装配：base_url={} model={} key={}",
        app_config.llm.base_url or "(未配置，聊天时引导去设置)",
        app_config.llm.model,
        mask_secret(get_llm_key()),  # 只记掩码，绝不记明文
    )

    pipeline = ChatPipeline(
        provider=runtime.llm,
        memories=memory_store,
        profile=profile_store,
        pet_name=runtime.pet_name,  # 每轮动态注入 pet.name（§7.6.3 改名即生效）
        tools=runtime.tools,  # 工具机制（§4.7）：快通道 / 模型 tools / 降级链
        notebook=notebook_service,  # 记忆本：system 注入 + open_item/delete_path 前置解析
        # 文件限额 / 上下文预算活引用：设置保存后下一轮即生效（§7.6.3）
        config=lambda: runtime.config,
    )

    # 语音链路（Phase 2）：按配置装配 TTS provider 进热替换槽；未知 provider 记
    # 日志降级，不阻断启动（语音是旁路能力，失败不影响对话主链路）；
    # 每条连接一个连接级语音出站（失败降级状态随连接存活，任务书第 5 条）
    runtime.apply_voice(app_config)

    # 自主行为引擎（Phase 3）：全局单例，决策行为并下发指令；无连接时自动跳过
    behavior_engine = BehaviorEngine(app_config.behavior)
    runtime.bind_behavior(behavior_engine)
    logger.info(
        "行为引擎装配：enabled={} 空闲 {:.0f}-{:.0f}s 免打扰={}",
        app_config.behavior.enabled,
        app_config.behavior.idle_min_seconds,
        app_config.behavior.idle_max_seconds,
        app_config.behavior.quiet_hours or "无",
    )

    # 记忆提取服务（Phase 3，§7.1）：会话空闲后后台提取 memories + profile；
    # 实例总是创建（enabled 开关需能热切换），由配置决定启动时是否运行；
    # 关闭时记忆注入仍可用（只读），只是不自动写入
    memory_service = MemoryService(
        provider=runtime.llm,
        store=memory_store,
        profile_store=profile_store,
        sessions=sessions,
        history=history_store,
        idle_seconds=app_config.memory.idle_seconds,
        check_interval_seconds=app_config.memory.check_interval_seconds,
        # 记忆本"遗忘名单"过滤：用户删掉的链接/路径不被后台从旧对话里重新提取
        is_forgotten=notebook_service.is_forgotten,
    )
    runtime.bind_memory(memory_service)
    if app_config.memory.enabled:
        logger.info(
            "记忆服务装配：空闲阈值 {}s 扫描周期 {}s",
            app_config.memory.idle_seconds,
            app_config.memory.check_interval_seconds,
        )
    else:
        logger.info("记忆提取未启用（config.toml [memory].enabled=false，设置面板可随时开启）")

    # 设置面板用例（§7.6）：get_config / set_config / test_llm
    settings = SettingsService(runtime=runtime)

    dispatcher = build_dispatcher(
        pipeline=pipeline,
        sessions=sessions,
        token=token,
        app_version=__version__,
        engine=behavior_engine,
        history=history_store,
        settings=settings,
        reminders=runtime.reminders,
        notebook=notebook_service,
    )
    app = create_app(
        dispatcher=dispatcher, app_version=__version__, voice_factory=runtime.voice_factory
    )

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
        asyncio.run(_serve(server, token=token, dev_mode=dev_mode, runtime=runtime))
    except KeyboardInterrupt:  # 兜底：正常退出码约定
        return 130
    return 0


async def _serve(
    server: uvicorn.Server,
    *,
    token: str,
    dev_mode: bool,
    runtime: Runtime | None = None,
) -> None:
    """启动 uvicorn，就绪后打印 READY 行，然后等待退出信号（SIGINT/SIGTERM）。

    运行时的后台服务（行为引擎 / 记忆提取）随服务启动，退出时随之停止；
    ``runtime=None`` 时行为与"无后台服务"一致（保序的装配兜底）。
    """
    serve_task = asyncio.create_task(server.serve(), name="uvicorn-serve")
    while not server.started:
        if serve_task.done():
            await serve_task  # 启动失败：让其异常向外传播
            raise RuntimeError("uvicorn 在完成启动前退出")
        await asyncio.sleep(0.02)

    port = _bound_port(server)
    if runtime is not None:
        runtime.start_services()
    emit_ready(port, token=token if dev_mode else None)
    try:
        await serve_task
    finally:
        if runtime is not None:
            await runtime.stop_services()


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
    """向 stdout 打印握手行（独立一行、立即 flush，供逐行解析）。

    编码：**直接写 UTF-8 字节**，绕过 sys.stdout 文本层的平台编码。对端（Electron 主进程
    readline）固定按 UTF-8 解码；Windows 下文本层是 cp936，一旦载荷出现非 ASCII
    （当前 port/pid/token 恰为 ASCII，但 json.dumps 用的是 ensure_ascii=False，已为将来新增
    字段留了口子）就会编出 GBK 字节、对端 JSON.parse 直接失败。字节直写对平台与解释器
    编码设置（含 PyInstaller 冻结产物不认 PYTHONUTF8 这一坑）都不敏感。
    """
    payload: dict[str, object] = {"port": port, "pid": os.getpid()}
    if token:
        payload["token"] = token
    line = (READY_PREFIX + json.dumps(payload, ensure_ascii=False) + "\n").encode("utf-8")
    buffer = getattr(sys.stdout, "buffer", None)
    if buffer is not None:
        buffer.write(line)
        buffer.flush()
    else:  # 兜底：流被替换成没有 buffer 的对象 → 退回文本层（仍按 UTF-8 语义写）
        sys.stdout.write(line.decode("utf-8"))
        sys.stdout.flush()
    logger.info("后端就绪 127.0.0.1:{} pid={}", port, os.getpid())


if __name__ == "__main__":
    raise SystemExit(main())
