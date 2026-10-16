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


def _force_utf8_stderr() -> None:
    """把 stderr 强制为 UTF-8（Windows 中文日志乱码的根治点，2026-10-16 实测）。

    背景：Python 在 Windows 下对**非终端**的 stdout/stderr（管道/重定向）使用 ANSI 代码页
    （中文系统 = cp936，即 GBK）编码，而消费端（Electron 主进程 readline / 日志工具）按 UTF-8
    解码 → 中文全成乱码。

    为什么不用环境变量了事（实测结论，别再踩）：
      · 源码运行：`PYTHONUTF8=1` 有效 ✅
      · **PyInstaller 冻结产物：`PYTHONUTF8=1` 与 `PYTHONIOENCODING=utf-8` 都无效** ❌
        —— 打包后的 bootloader 自行决定 stdio 编码，不认这两个开关。
        （环境变量本身是透传的：PET_DATA_DIR/PET_TOKEN 在冻结产物里都正常工作。）
    故改为在 Python 侧 reconfigure——源码与冻结产物行为一致，是唯一两处都可靠的开关。

    errors="replace"：即便遇到目标编码表达不了的字符也降级成替代符，绝不让"写日志"本身抛异常。
    在 loguru 接管 sink **之前**调用（见 setup_logging），sink 绑定的就是已重配的流。
    """
    stream = sys.stderr
    reconfigure = getattr(stream, "reconfigure", None)
    if reconfigure is None:  # 极少数被替换过的流对象没有 reconfigure → 保持原样
        return
    try:
        reconfigure(encoding="utf-8", errors="replace")
    except Exception:  # 重配失败不能拖垮启动：日志退化为平台默认编码，功能不受影响
        pass


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

    _force_utf8_stderr()  # 必须先于 sink 绑定：sink 持有的是流对象，重配要发生在绑定之前

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
