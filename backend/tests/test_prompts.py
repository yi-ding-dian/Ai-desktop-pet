"""modules/llm/prompts 单测：提示词资产内容与 system prompt 组装。"""

from __future__ import annotations

import re

from backend.modules.chat.emotion import EMOTION_VALUES
from backend.modules.llm.prompts import (
    build_system_prompt,
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


def test_persona_notes_future_character_package_override() -> None:
    """persona.md 必须注明将来由角色包覆盖（设计文档 §4.6）。"""
    persona = load_persona()
    assert "角色包" in persona
    assert "§4.6" in persona


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
