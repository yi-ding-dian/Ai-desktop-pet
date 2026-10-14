"""shared/secrets.py 单测：读取链优先级 / keyring 回退 / 掩码与脱敏 / 文件权限。

注意：不触碰真实 keyring（用 monkeypatch 替换读写原语），也不使用真实 key。
"""

from __future__ import annotations

import json
import stat
from pathlib import Path

import pytest

from backend.shared import secrets

ENV_KEY = "env-key-0123456789"
RING_KEY = "ring-key-0123456789"
FILE_KEY = "file-key-0123456789"


@pytest.fixture(autouse=True)
def _isolate(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """隔离环境：PET_DATA_DIR 指向临时目录、清空环境变量、恢复脱敏集合。"""
    monkeypatch.setenv("PET_DATA_DIR", str(tmp_path))
    monkeypatch.delenv(secrets.ENV_KEY_NAME, raising=False)
    saved = set(secrets._known_secrets)
    yield tmp_path
    secrets._known_secrets.clear()
    secrets._known_secrets.update(saved)


@pytest.fixture
def file_only(monkeypatch: pytest.MonkeyPatch) -> None:
    """模拟 keyring 不可用（读 None / 写 False）。"""
    monkeypatch.setattr(secrets, "_keyring_get", lambda: None)
    monkeypatch.setattr(secrets, "_keyring_set", lambda key: False)


# ---------------------------------------------------------------- 掩码与脱敏


def test_mask_secret() -> None:
    assert secrets.mask_secret(None) == "(未配置)"
    assert secrets.mask_secret("") == "(未配置)"
    assert secrets.mask_secret("short") == "****"  # 过短全掩码，防反推
    assert secrets.mask_secret("abcdefghijklmnop") == "abc****mnop"


def test_redact_replaces_registered_secret() -> None:
    secrets.register_secret(FILE_KEY)
    out = secrets.redact(f"上游报错：{FILE_KEY} 无效")
    assert FILE_KEY not in out
    assert secrets.mask_secret(FILE_KEY) in out


def test_redact_leaves_unknown_text_untouched() -> None:
    assert secrets.redact("普通文本 abc") == "普通文本 abc"


# ---------------------------------------------------------------- 读取链优先级


def test_env_var_has_top_priority(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(secrets.ENV_KEY_NAME, ENV_KEY)
    monkeypatch.setattr(secrets, "_keyring_get", lambda: RING_KEY)
    secrets._write_file(FILE_KEY)
    assert secrets.get_llm_key() == ENV_KEY


def test_keyring_beats_file(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(secrets, "_keyring_get", lambda: RING_KEY)
    secrets._write_file(FILE_KEY)
    assert secrets.get_llm_key() == RING_KEY


def test_file_used_when_keyring_unavailable(file_only: None) -> None:
    secrets._write_file(FILE_KEY)
    assert secrets.get_llm_key() == FILE_KEY


def test_returns_none_when_nothing_configured(file_only: None) -> None:
    assert secrets.get_llm_key() is None
    assert secrets.has_llm_key() is False


def test_keyring_broken_file_absent_returns_none(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(secrets, "_keyring_get", lambda: None)
    assert secrets.get_llm_key() is None


# ---------------------------------------------------------------- 写入策略


def test_set_key_prefers_keyring(monkeypatch: pytest.MonkeyPatch) -> None:
    written: list[str] = []

    def fake_set(key: str) -> bool:
        written.append(key)
        return True

    monkeypatch.setattr(secrets, "_keyring_set", fake_set)
    where = secrets.set_llm_key(RING_KEY)

    assert where == "keyring"
    assert written == [RING_KEY]
    assert not secrets.secret_file_path().exists()  # keyring 成功则不落文件


def test_set_key_falls_back_to_600_file(file_only: None) -> None:
    where = secrets.set_llm_key(FILE_KEY)
    path = secrets.secret_file_path()

    assert where == f"file:{path}"
    assert path.exists()
    assert stat.S_IMODE(path.stat().st_mode) == 0o600
    assert json.loads(path.read_text(encoding="utf-8"))["llm_api_key"] == FILE_KEY
    assert secrets.get_llm_key() == FILE_KEY  # 写后可读回


def test_file_permission_corrected_on_rewrite(file_only: None) -> None:
    path = secrets.secret_file_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("{}", encoding="utf-8")
    path.chmod(0o644)  # 模拟历史上以宽松权限存在的文件
    secrets.set_llm_key(FILE_KEY)
    assert stat.S_IMODE(path.stat().st_mode) == 0o600


def test_empty_key_rejected() -> None:
    with pytest.raises(ValueError):
        secrets.set_llm_key("   ")
