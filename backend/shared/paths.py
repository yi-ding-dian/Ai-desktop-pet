"""用户数据目录解析。

目录由 Electron 主进程计算后经环境变量 PET_DATA_DIR 传入，保证前后端一致
（设计文档 §6.1）；独立开发/自测时缺省 fallback 到各平台惯用位置：
Linux → ~/.config/ai-desktop-pet，Windows → %APPDATA%\\ai-desktop-pet。
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

DEFAULT_DATA_DIR_NAME = "ai-desktop-pet"


def _fallback_dir() -> Path:
    """无 PET_DATA_DIR 时的缺省目录（按平台惯例；Windows 不写 ~/.config 那种 dot 目录）。"""
    if sys.platform == "win32":
        base = (os.environ.get("APPDATA") or "").strip()
        if base:
            return Path(base) / DEFAULT_DATA_DIR_NAME
    return Path.home() / ".config" / DEFAULT_DATA_DIR_NAME


def get_data_dir() -> Path:
    """返回用户数据目录（不保证存在）。"""
    env = (os.environ.get("PET_DATA_DIR") or "").strip()
    if env:
        return Path(env).expanduser()
    return _fallback_dir()


def ensure_data_dir() -> Path:
    """返回用户数据目录并确保其存在。"""
    data_dir = get_data_dir()
    data_dir.mkdir(parents=True, exist_ok=True)
    return data_dir


def get_logs_dir() -> Path:
    """日志目录（PET_DATA_DIR/logs/），自动创建。"""
    logs_dir = ensure_data_dir() / "logs"
    logs_dir.mkdir(parents=True, exist_ok=True)
    return logs_dir


def get_config_path() -> Path:
    """配置文件路径（PET_DATA_DIR/config.toml）。"""
    return get_data_dir() / "config.toml"
