"""modules/tools 域单测：注册表增查、OpenAI 协议转换、内置工具、快通道指令词表。"""

from __future__ import annotations

from typing import Any

import pytest

from backend.modules.tools import (
    ToolRegistry,
    ToolSpec,
    build_default_registry,
    match_directive,
)


def make_spec(name: str = "demo_tool", **overrides: Any) -> ToolSpec:
    """构造测试用工具定义（全假数据）。"""
    kwargs: dict[str, Any] = dict(
        name=name,
        description="演示工具",
        parameters={"type": "object", "properties": {"q": {"type": "string"}}},
    )
    kwargs.update(overrides)
    return ToolSpec(**kwargs)


# ---------------------------------------------------------------- 注册表


def test_register_and_get() -> None:
    registry = ToolRegistry()
    spec = make_spec()
    registry.register(spec)
    assert registry.get("demo_tool") is spec


def test_register_duplicate_name_raises() -> None:
    """重名注册抛 ValueError（早暴露装配错误，不静默覆盖）。"""
    registry = ToolRegistry()
    registry.register(make_spec())
    with pytest.raises(ValueError, match="重名"):
        registry.register(make_spec(description="另一个"))


def test_get_unknown_returns_none() -> None:
    assert ToolRegistry().get("nope") is None


def test_all_returns_in_registration_order() -> None:
    registry = ToolRegistry()
    registry.register(make_spec("t1"))
    registry.register(make_spec("t2"))
    assert [s.name for s in registry.all()] == ["t1", "t2"]
    # 返回副本列表：外部增删不影响注册表内部
    registry.all().append(make_spec("t3"))
    assert [s.name for s in registry.all()] == ["t1", "t2"]


def test_to_openai_tools_format() -> None:
    """转 OpenAI 协议格式：type=function + function{name, description, parameters}。"""
    registry = ToolRegistry()
    registry.register(make_spec())
    assert registry.to_openai_tools() == [
        {
            "type": "function",
            "function": {
                "name": "demo_tool",
                "description": "演示工具",
                "parameters": {
                    "type": "object",
                    "properties": {"q": {"type": "string"}},
                },
            },
        }
    ]


def test_toolspec_defaults() -> None:
    """缺省字段：frontend 执行、无 handler、ack 为空。"""
    spec = make_spec()
    assert spec.executor == "frontend"
    assert spec.handler is None
    assert spec.ack == ""


# ---------------------------------------------------------------- 内置工具


def test_default_registry_contains_open_settings() -> None:
    registry = build_default_registry()
    spec = registry.get("open_settings")
    assert spec is not None
    assert spec.executor == "frontend"  # 前端执行（打开设置窗）
    assert spec.parameters == {"type": "object", "properties": {}}  # 无参工具
    assert spec.ack  # 模型没说话时的确认话兜底
    assert [s.name for s in registry.all()] == ["open_settings"]
    # 模型可见的描述：明确"什么场景用"
    assert "设置" in spec.description


def test_default_registry_is_fresh_each_call() -> None:
    """每次返回全新实例（调用方之间不共享可变状态）。"""
    assert build_default_registry() is not build_default_registry()


# ---------------------------------------------------------------- 快通道指令词表


@pytest.mark.parametrize(
    "text",
    ["打开设置", "帮我打开设置面板", "设置面板在哪？", "请帮我打开设置。"],
)
def test_match_directive_hits(text: str) -> None:
    """包含匹配（与迁移前前端正则行为一致）：句子中带关键词即命中。"""
    assert match_directive(text) == "open_settings"


@pytest.mark.parametrize(
    "text",
    ["今天天气怎么样？", "设置里有什么？", "换个话题", "", "晚安"],
)
def test_match_directive_misses(text: str) -> None:
    """只提"设置"不构成指令（问内容/闲聊）——与能力清单的调用边界一致。"""
    assert match_directive(text) is None
