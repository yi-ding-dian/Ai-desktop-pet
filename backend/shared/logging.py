"""loguru 日志配置：控制台（stderr）+ 文件滚动（PET_DATA_DIR/logs/）。

约定：控制台输出走 **stderr**，stdout 只留给启动握手行（PET_READY），
保证 Electron 主进程逐行解析 stdout 时不被日志污染（设计文档 §3.4）。
"""

from __future__ import annotations

import sys

from loguru import logger

from backend.shared import secrets
from backend.shared.paths import get_logs_dir

_console_format = (
    "<green>{time:YYYY-MM-DD HH:mm:ss.SSS}</green> | "
    "<level>{level: <7}</level> | "
    "<cyan>{name}</cyan>:<cyan>{line}</cyan> - <level>{message}</level>"
)

_configured = False


def _redact_filter(record: dict) -> bool:
    """日志兜底脱敏：把消息中出现的已登记密钥（shared.secrets）替换为掩码。

    最后一道防线——正常代码路径本就不得把 key 写进日志，此过滤器保证
    "万一"（如第三方 SDK 报错文本夹带）也不会泄漏明文。
    """
    try:
        message = record.get("message")
        if isinstance(message, str) and message:
            record["message"] = secrets.redact(message)
    except Exception:  # 脱敏失败不阻断日志本身
        pass
    return True


def setup_logging(level: str = "INFO", *, to_file: bool = True) -> None:
    """初始化日志（幂等）。level 可由 PET_LOG_LEVEL 环境变量覆盖。"""
    global _configured
    if _configured:
        return

    logger.remove()  # 移除 loguru 默认 sink，统一由这里接管
    logger.add(
        sys.stderr,
        level=level.upper(),
        format=_console_format,
        filter=_redact_filter,
        enqueue=True,
    )

    if to_file:
        log_path = get_logs_dir() / "backend_{time:YYYY-MM-DD}.log"
        logger.add(
            str(log_path),
            level=level.upper(),
            format=_console_format,
            filter=_redact_filter,
            rotation="10 MB",
            retention="7 days",
            encoding="utf-8",
            enqueue=True,
        )

    _configured = True
