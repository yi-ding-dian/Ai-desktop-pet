"""设置面板用例（设计文档 §7.6.2 数据流 / §7.6.3 保存与生效）。

三个用例（对应 §3.2 的 ``get_config`` / ``set_config`` / ``test_llm``）：

- **快照**：当前配置全量 + LLM key 掩码（**绝不回明文**，§6.3）；
- **保存**：patch 白名单校验（失败抛 :class:`ConfigInvalid`，message 说明具体
  原因）→ key 单独入 keyring（空 / 未提供 / 掩码回显 = 不修改）→ 写回
  config.toml（key 不进 toml）→ Runtime 热重装配 → 返回新快照作回执；
- **测试连接**：用覆盖参数（缺省用当前配置；key 缺省用读取链——keyring 为主）
  发最小请求 + 尽力拉 ``/models`` 列表 → ``llm_test_result`` 载荷
  （失败说明具体原因；models 拉不到就省略，不报错）。

依赖方向：application 层——依赖 shared（config/secrets）与 Runtime；
不 import interfaces（WS 事件转换由 dispatcher 完成）。
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from loguru import logger
from pydantic import ValidationError

from backend.application.runtime import Runtime
from backend.shared.config import AppConfig, save_config
from backend.shared.secrets import get_llm_key, mask_secret, set_llm_key

#: patch 允许出现的配置域（与设置面板分区一致，§7.6.1）
_ALLOWED_SECTIONS = ("llm", "pet", "voice", "behavior", "memory", "files")
#: patch 顶层 key 专用字段（设置 LLM API key；空/未提供 = 不修改）
_KEY_FIELD = "key"
#: patch 内 key 专用字段（设置面板约定放 ``llm.api_key``；与顶层 key 等价）
_KEY_FIELD_IN_LLM = "api_key"


class ConfigInvalid(Exception):
    """设置 patch 校验失败（dispatcher 转为 error{code:"CONFIG_INVALID"}）。"""

    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.message = message


class SettingsService:
    """设置面板用例编排（get_config / set_config / test_llm）。"""

    def __init__(self, *, runtime: Runtime, config_path: Path | None = None) -> None:
        """
        - ``runtime``：运行时可重装配控制面（保存后分派到各模块）；
        - ``config_path``：配置文件路径（None = 默认 PET_DATA_DIR/config.toml）。
        """
        self._runtime = runtime
        self._config_path = config_path

    # ---------------------------------------------------------------- get_config

    def snapshot(self) -> dict[str, Any]:
        """当前配置快照（§3.3 ``config``）：全量结构 + LLM key 掩码。

        掩码字段给两个名字（同值）：``llm.api_key``（设置面板约定读取名）与
        ``llm.key``（别名）；两者都只含掩码，**绝不回明文**。
        """
        data = self._runtime.config.model_dump(mode="json")
        masked = mask_secret(get_llm_key())
        data["llm"]["api_key"] = masked
        data["llm"]["key"] = masked
        return data

    # ---------------------------------------------------------------- set_config

    async def apply_patch(self, patch: dict[str, Any]) -> dict[str, Any]:
        """应用设置 patch：校验 → 持久化 → 热重装配 → 返回新快照（回执）。

        失败语义：
        - 字段级问题抛 :class:`ConfigInvalid`（含具体原因），**不改动任何状态**；
        - 写盘 / 装配的意外异常向上抛（dispatcher 兜底为 INTERNAL）；
        - 单项装配失败（如未知 TTS provider）由 Runtime 内部降级，不算失败。
        """
        new_config = self._merge_and_validate(patch)
        new_key = _extract_key(patch)
        if new_key is not None:
            where = set_llm_key(new_key)  # 落 keyring（不可用时自动落 600 权限文件）
            logger.info("LLM key 已更新（落点：{}，明文不落日志）", where)
        save_config(new_config, self._config_path)
        await self._runtime.apply(new_config)
        logger.info(
            "配置已保存并热重装配：llm.model={} pet.name={}",
            new_config.llm.model,
            new_config.pet.name,
        )
        return self.snapshot()

    # ---------------------------------------------------------------- test_llm

    async def test_llm(
        self,
        *,
        base_url: str | None = None,
        model: str | None = None,
        key: str | None = None,
    ) -> dict[str, Any]:
        """测试连接（§3.2 ``test_llm`` → §3.3 ``llm_test_result`` 载荷）。

        base_url / model 缺省用当前配置；key 缺省用读取链（keyring 为主）。
        """
        result = await self._runtime.llm.probe(
            base_url=base_url, model=model, api_key=key
        )
        payload: dict[str, Any] = {"ok": result.ok, "message": result.message}
        if result.models:
            payload["models"] = result.models
        return payload

    # ---------------------------------------------------------------- 内部实现

    def _merge_and_validate(self, patch: dict[str, Any]) -> AppConfig:
        """patch 合并进当前配置并做整树校验；失败抛 ConfigInvalid（含具体原因）。"""
        if not isinstance(patch, dict):
            raise ConfigInvalid("patch 必须是 JSON 对象")

        unknown = sorted(set(patch) - set(_ALLOWED_SECTIONS) - {_KEY_FIELD})
        if unknown:
            raise ConfigInvalid(f"不支持的配置项：{', '.join(unknown)}")

        merged = self._runtime.config.model_dump(mode="json")
        for section, values in patch.items():
            if section == _KEY_FIELD:
                continue
            if not isinstance(values, dict):
                raise ConfigInvalid(
                    f"{section} 必须是对象（如 {{\"{section}\": {{...}}}}）"
                )
            config_values = dict(values)
            if section == "llm":
                # key 专用字段不进配置树（单独入 keyring，见 apply_patch）
                config_values.pop(_KEY_FIELD_IN_LLM, None)
            unknown_fields = sorted(set(config_values) - set(merged[section]))
            if unknown_fields:
                raise ConfigInvalid(
                    f"{section} 下不支持的字段：{', '.join(unknown_fields)}"
                )
            merged[section].update(config_values)

        try:
            return AppConfig.model_validate(merged)
        except ValidationError as exc:
            raise ConfigInvalid(_brief_validation(exc)) from exc


def _extract_key(patch: dict[str, Any]) -> str | None:
    """从 patch 取新 key；空 / 未提供 / 掩码回显（前端只拿到掩码）→ None（不修改）。

    两种位置等价：顶层 ``key`` 与 ``llm.api_key``（设置面板约定）。
    """
    raw = patch.get(_KEY_FIELD)
    if raw is None:
        llm_values = patch.get("llm")
        if isinstance(llm_values, dict):
            raw = llm_values.get(_KEY_FIELD_IN_LLM)
    if raw is None:
        return None
    if not isinstance(raw, str):
        raise ConfigInvalid("key 必须是字符串")
    text = raw.strip()
    if not text or "****" in text:
        return None
    return text


def _brief_validation(exc: ValidationError, limit: int = 3) -> str:
    """把 Pydantic 校验错误压缩成一行可读的具体原因（去 Value error 前缀）。"""
    items = []
    for err in exc.errors()[:limit]:
        loc = ".".join(str(part) for part in err.get("loc", ())) or "(root)"
        msg = str(err.get("msg", "校验失败"))
        prefix = "Value error, "
        if msg.startswith(prefix):
            msg = msg[len(prefix) :]
        items.append(f"{loc}: {msg}")
    return "；".join(items)
