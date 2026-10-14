"""loguru 日志配置：控制台（stderr）+ 文件滚动（PET_DATA_DIR/logs/）。

约定：控制台输出走 **stderr**，stdout 只留给启动握手行（PET_READY），
保证 Electron 主进程逐行解析 stdout 时不被日志污染（设计文档 §3.4）。
"""

from __future__ import annotations

import sys

from loguru import logger

from backend.shared.paths import get_logs_dir

_console_format = (
    "<green>{time:YYYY-MM-DD HH:mm:ss.SSS}</green> | "
    "<level>{level: <7}</level> | "
    "<cyan>{name}</cyan>:<cyan>{line}</cyan> - <level>{message}</level>"
)

_configured = False


def setup_logging(level: str = "INFO", *, to_file: bool = True) -> None:
    """初始化日志（幂等）。level 可由 PET_LOG_LEVEL 环境变量覆盖。"""
    global _configured
    if _configured:
        return

    logger.remove()  # 移除 loguru 默认 sink，统一由这里接管
    logger.add(sys.stderr, level=level.upper(), format=_console_format, enqueue=True)

    if to_file:
        log_path = get_logs_dir() / "backend_{time:YYYY-MM-DD}.log"
        logger.add(
            str(log_path),
            level=level.upper(),
            format=_console_format,
            rotation="10 MB",
            retention="7 days",
            encoding="utf-8",
            enqueue=True,
        )

    _configured = True
