"""modules/llm/prompts 单测：提示词资产内容与 system prompt 组装。"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from backend.modules.chat.emotion import EMOTION_VALUES
from backend.modules.llm import prompts
from backend.modules.llm.prompts import (
    build_system_prompt,
    load_capabilities,
    load_emotion_directive,
    load_persona,
)


def test_system_prompt_contains_persona_and_directive() -> None:
    prompt = build_system_prompt()
    assert "小兔" in prompt  # 人格设定
    assert "情绪" in prompt  # 情绪指令


def test_emotion_values_cover_v1_whitelist_exactly() -> None:
    """提示词列出的情绪标签集合 == chat 白名单（§3.3 单一事实来源一致性）。"""
    prompt = build_system_prompt()
    found = set(re.findall(r"<emo:([a-z_]+)>", prompt))
    assert found == set(EMOTION_VALUES)


def test_persona_assets_stay_token_lean() -> None:
    """persona.md 只保留真正进模型的设定。

    “将来由角色包覆盖”的说明放在模块 docstring 里（仍可查），不再以 HTML 注释
    混进 system prompt 白烧 token（2026-10-24）。
    """
    persona = load_persona()
    assert "<!--" not in persona
    assert "角色包" not in persona


def test_persona_override_takes_effect() -> None:
    """角色包人格注入缝：persona_text 参数覆盖默认人格，情绪指令仍拼接。"""
    prompt = build_system_prompt(persona_text="你是测试角色小白。")
    assert prompt.startswith("你是测试角色小白。")
    assert "<emo:happy>" in prompt


def test_directive_tolerates_missing_tags() -> None:
    """指令中说明"可以不写标签"（缺标签容忍的另一半）。"""
    directive = load_emotion_directive()
    assert "可以不写" in directive


# ---------------------------------------------------------------- 名字注入（§7.6.3）


def test_pet_name_injected_after_persona() -> None:
    """pet_name 非空：在人格设定之后叠加"你的名字叫 X"，压过 persona 里的旧名。"""
    prompt = build_system_prompt(pet_name="毛毛")
    assert "你的名字叫「毛毛」" in prompt
    assert "以这个名字为准" in prompt  # 明确优先级，避免 persona 旧名与新名打架
    # 仍以人格开头、情绪指令收尾（叠加不破坏结构）
    assert prompt.startswith(load_persona())
    assert "<emo:happy>" in prompt


def test_pet_name_blank_or_none_not_injected() -> None:
    """空串 / 纯空白 / None：不注入名字，输出与旧版逐字一致（零回归）。"""
    plain = build_system_prompt()
    assert "你的名字叫" not in plain
    assert build_system_prompt(pet_name=None) == plain
    assert build_system_prompt(pet_name="   ") == plain


def test_pet_name_composes_with_persona_override() -> None:
    """名字注入与角色包 persona_text 覆盖机制叠加（§4.6 不被破坏）。"""
    prompt = build_system_prompt(persona_text="你是测试角色小白。", pet_name="毛毛")
    assert prompt.startswith("你是测试角色小白。")
    assert "你的名字叫「毛毛」" in prompt
    assert "<emo:happy>" in prompt


# ---------------------------------------------------------------- 工具清单与使用规则（§4.7）


def test_tool_lines_injected_into_system_prompt() -> None:
    """工具清单按注册表动态注入：模型据此知道可调用 open_settings（而非只给操作步骤）。"""
    prompt = build_system_prompt(tool_lines=["- open_settings：打开小兔的设置面板"])
    assert "可用工具：" in prompt
    assert "open_settings" in prompt
    assert "设置面板" in prompt
    assert "工具" in prompt


def test_tool_lines_injected_with_persona_override_and_name() -> None:
    """叠加不破坏既有结构：人格/名字在前，工具清单在后。"""
    prompt = build_system_prompt(
        persona_text="你是测试角色小白。",
        pet_name="毛毛",
        tool_lines=["- open_settings：打开小兔的设置面板"],
    )
    assert prompt.startswith("你是测试角色小白。")
    assert prompt.index("你的名字叫「毛毛」") < prompt.index("open_settings")


def test_capabilities_file_holds_rules_not_tool_list() -> None:
    """capabilities.md 只放跨工具规则；工具清单由注册表动态生成（避免漂移）。"""
    text = load_capabilities()
    assert "好嘞" in text  # "调用前后用一句自然口语回应"的示例
    assert "使用要求" in text
    # 不再静态列举工具（“可用工具：”段 + “- 工具名：”行都由注册表生成）
    assert "可用工具：" not in text
    assert "- open_settings：" not in text


def test_capabilities_fallback_when_file_missing(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """capabilities.md 缺失时用模块内兜底规则（服务不因资产缺失而失去策略）。"""
    monkeypatch.setattr(prompts, "_PROMPTS_DIR", tmp_path)
    text = load_capabilities()
    assert text == prompts._FALLBACK_CAPABILITIES
    assert "使用要求" in text
