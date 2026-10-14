"""API key 读取链与全链路脱敏（设计文档 §6.3）。

读取优先级：
    环境变量 ``PET_LLM_KEY`` > 系统 keyring > 本地文件 ``PET_DATA_DIR/llm_secret.json``（权限 600）

写入策略：keyring 可用则写 keyring；不可用/写入失败则落到 600 权限文件。

安全红线（全项目约定）：
- key 明文**不得**出现在代码、日志、异常信息、WS 事件与测试输出中；
- 需要展示时一律走 :func:`mask_secret`；
- 拼接自由文本（尤其是来自第三方 SDK 的错误信息）时走 :func:`redact`，
  依赖 :func:`register_secret` 登记的进程内密钥集合做兜底清洗。

注意：本模块只负责"读写 key"这一件事；key 的使用方（llm provider）不感知存储细节。
"""

from __future__ import annotations

import json
import os
from pathlib import Path

from backend.shared.paths import ensure_data_dir, get_data_dir

# —— 存储常量 ——

ENV_KEY_NAME = "PET_LLM_KEY"  # 环境变量名（最高优先级）
KEYRING_SERVICE = "ai-desktop-pet"  # keyring 服务名
KEYRING_USERNAME = "llm_api_key"  # keyring 用户名（同一服务下可扩展多个条目）
SECRET_FILE_NAME = "llm_secret.json"  # 兜底文件（PET_DATA_DIR 下，权限 600）
_SECRET_FILE_MODE = 0o600


def secret_file_path() -> Path:
    """兜底密钥文件路径（PET_DATA_DIR/llm_secret.json）。"""
    return get_data_dir() / SECRET_FILE_NAME


# —— 脱敏工具 ——


def mask_secret(secret: str | None) -> str:
    """把 key 变成可安全展示的掩码（如 ``sk-****f3a9``）。

    - None / 空串 → ``(未配置)``
    - 过短的字符串（≤8）全掩码，避免通过掩码反推
    """
    if not secret:
        return "(未配置)"
    if len(secret) <= 8:
        return "****"
    return f"{secret[:3]}****{secret[-4:]}"


# 进程内已见过的密钥集合（供 redact 兜底清洗任意文本）
_known_secrets: set[str] = set()


def register_secret(secret: str | None) -> None:
    """登记一个密钥；此后 :func:`redact` 会在任意文本中把它替换为掩码。"""
    if secret and len(secret) >= 8:
        _known_secrets.add(secret)


def redact(text: str) -> str:
    """把文本中出现的已登记密钥替换为掩码（第三方 SDK 错误信息的兜底清洗）。"""
    for secret in _known_secrets:
        if secret in text:
            text = text.replace(secret, mask_secret(secret))
    return text


# —— 读取链 ——


def get_llm_key() -> str | None:
    """按优先级读取 LLM API key；读到的 key 自动登记进脱敏集合，未配置返回 None。"""
    key = _from_env() or _from_keyring() or _from_file()
    if key:
        register_secret(key)
    return key


def has_llm_key() -> bool:
    """是否已配置 LLM API key（不读出内容）。"""
    return get_llm_key() is not None


def _from_env() -> str | None:
    value = (os.environ.get(ENV_KEY_NAME) or "").strip()
    return value or None


def _from_keyring() -> str | None:
    """读 keyring；不可用（无 Secret Service / 无会话）或未配置时返回 None。"""
    value = (_keyring_get() or "").strip()
    return value or None


def _keyring_get() -> str | None:
    """keyring 读取原语（独立函数便于测试替换）；任何异常都视为不可用。"""
    try:
        import keyring

        return keyring.get_password(KEYRING_SERVICE, KEYRING_USERNAME)
    except Exception:
        return None


def _keyring_set(key: str) -> bool:
    """keyring 写入原语（独立函数便于测试替换）；失败返回 False 由上层回退文件。"""
    try:
        import keyring

        keyring.set_password(KEYRING_SERVICE, KEYRING_USERNAME, key)
        return True
    except Exception:
        return False


def _from_file() -> str | None:
    """读兜底文件；不存在 / 损坏时返回 None（损坏不影响主流程，仅记不了日志——这里不引入日志依赖）。"""
    path = secret_file_path()
    try:
        raw = path.read_text(encoding="utf-8")
        value = str(json.loads(raw).get("llm_api_key") or "").strip()
    except (OSError, ValueError):
        return None
    return value or None


# —— 写入 ——


def set_llm_key(key: str) -> str:
    """持久化 key（keyring 优先，失败落 600 文件）；返回落点描述，供调用方记日志。

    返回值形如 ``"keyring"`` 或 ``"file:<路径>"``（不含 key 本身）。
    """
    key = (key or "").strip()
    if not key:
        raise ValueError("key 不能为空")
    register_secret(key)

    if _write_keyring(key):
        return "keyring"
    return f"file:{_write_file(key)}"


def _write_keyring(key: str) -> bool:
    """写 keyring；不可用 / 失败返回 False（由调用方回退到文件）。"""
    return _keyring_set(key)


def _write_file(key: str) -> Path:
    """写 600 权限的兜底文件（创建即 600，已存在则校正权限）。"""
    path = ensure_data_dir() / SECRET_FILE_NAME
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, _SECRET_FILE_MODE)
    try:
        f = os.fdopen(fd, "w", encoding="utf-8")
    except Exception:
        os.close(fd)  # fdopen 失败时 fd 未被接管，需自行关闭
        raise
    with f:  # 成功接管后由文件对象负责关闭
        json.dump({"llm_api_key": key}, f, ensure_ascii=False)
    os.chmod(path, _SECRET_FILE_MODE)  # 文件可能先前以更宽权限存在，强制校正
    return path
