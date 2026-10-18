"""modules/tools 域单测：注册表增查、OpenAI 协议转换、内置工具、快通道指令词表。"""

from __future__ import annotations

import asyncio
from typing import Any

import pytest

from backend.modules.tools import (
    ToolRegistry,
    ToolSpec,
    build_default_registry,
    match_directive,
    match_forced_tool,
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
    assert [s.name for s in registry.all()] == ["open_settings", "open_work"]
    # 模型可见的描述：明确"什么场景用"
    assert "设置" in spec.description


def test_default_registry_is_fresh_each_call() -> None:
    """每次返回全新实例（调用方之间不共享可变状态）。"""
    assert build_default_registry() is not build_default_registry()


# ---------------------------------------------------------------- 提醒工具（2026-10-18）


class FakeReminderServiceTools:
    """提醒服务替身：只验证工具定义/handler 转发，不碰存储。"""

    def create_from_tool(self, *, text: str, due_at: str, repeat: str) -> dict:
        return {
            "ok": True,
            "code": "reminder_created",
            "message": f"已设置提醒 · {text} · {due_at} · {repeat}",
        }

    def list_for_tool(self, limit: int = 20) -> dict:
        return {"ok": True, "code": "reminders_listed", "message": f"列出 {limit} 条"}

    def cancel_from_tool(self, *, key: str) -> dict:
        return {"ok": True, "code": "reminder_cancelled", "message": f"取消 {key}"}


def test_default_registry_registers_backend_reminder_tools() -> None:
    """注入提醒服务后多出 3 个 backend 型工具；handler 直接转发给服务。"""
    registry = build_default_registry(FakeReminderServiceTools())
    assert [s.name for s in registry.all()] == [
        "open_settings",
        "open_work",
        "create_reminder",
        "list_reminders",
        "cancel_reminder",
    ]
    spec = registry.get("create_reminder")
    assert spec is not None and spec.executor == "backend" and spec.handler is not None
    result = spec.handler(
        {"text": "交房租", "due_at": "2026-10-18T09:00:00+08:00", "repeat": "daily"}
    )
    assert result["code"] == "reminder_created"
    assert "交房租" in result["message"]


def test_default_registry_without_service_keeps_old_tools() -> None:
    """未注入提醒服务（旧装配/单测）：注册表与旧版逐字一致。"""
    assert [s.name for s in build_default_registry().all()] == [
        "open_settings",
        "open_work",
    ]


# ---------------------------------------------------------------- 记忆本工具（2026-10-18）


class FakeNotebookServiceTools:
    """记忆本服务替身：只验证工具定义/参数转发/前置解析接线，不碰存储。"""

    def save_from_tool(self, items):
        return {"ok": True, "code": "items_saved", "message": f"存了 {len(items or [])} 条"}

    def list_from_tool(self, kind=None, limit=50):
        return {"ok": True, "code": "items_listed", "message": f"列出 {limit} 条（{kind}）"}

    def rename_from_tool(self, old_name, new_name):
        return {"ok": True, "code": "item_renamed", "message": f"{old_name}->{new_name}"}

    def delete_from_tool(self, names, user_text=""):
        return {"ok": True, "code": "items_deleted", "message": f"删 {names}（{user_text}）"}

    def prepare_open(self, args, user_text):
        return {"ok": True, "args": {"kind": "link", "value": "https://resolved", "name": args.get("name", "")}}

    def prepare_delete_path(self, args, user_text):
        return {"ok": True, "args": {"kind": "file", "path": "D:\\a.txt", "name": args.get("name", "")}}


def test_default_registry_registers_notebook_tools() -> None:
    registry = build_default_registry(notebook=FakeNotebookServiceTools())
    assert [s.name for s in registry.all()] == [
        "open_settings",
        "open_work",
        "save_item",
        "list_items",
        "rename_item",
        "delete_item",
        "open_item",
        "delete_path",
    ]
    assert registry.get("save_item").executor == "backend"
    assert registry.get("delete_item").needs_user_text is True
    assert registry.get("open_item").executor == "frontend"
    assert registry.get("open_item").prepare is not None
    assert registry.get("delete_path").prepare is not None


def test_notebook_tool_handlers_forward() -> None:
    notebook = FakeNotebookServiceTools()
    registry = build_default_registry(notebook=notebook)
    save = registry.get("save_item")
    assert save is not None and save.handler is not None
    assert save.handler({"items": [{"value": "https://a.com"}]})["message"] == "存了 1 条"

    listed = registry.get("list_items")
    assert listed is not None and listed.handler is not None
    assert "20" in listed.handler({"limit": "20", "kind": "link"})["message"]

    renamed = registry.get("rename_item")
    assert renamed is not None and renamed.handler is not None
    assert "old->new" in renamed.handler({"old_name": "old", "new_name": "new"})["message"]

    deleted = registry.get("delete_item")
    assert deleted is not None and deleted.handler is not None
    assert "hi" in deleted.handler({"names": ["x"]}, "hi")["message"]


def test_reminder_tool_missing_or_bad_args_are_sanitized() -> None:
    """模型漏传/传错类型：字段按空串处理，不出现字面量 "None"；limit 非法回落 20。"""
    registry = build_default_registry(FakeReminderServiceTools())
    create = registry.get("create_reminder")
    assert create is not None and create.handler is not None
    result = create.handler({"text": None, "due_at": None, "repeat": 123})
    assert "None" not in result["message"]
    assert "123" not in result["message"]

    list_spec = registry.get("list_reminders")
    assert list_spec is not None and list_spec.handler is not None
    assert list_spec.handler({"limit": "abc"})["message"] == "列出 20 条"


# ---------------------------------------------------------------- 联网搜索工具（2026-10-18）


class FakeSearchServiceTools:
    async def search_from_tool(self, args, user_text=""):
        return {
            "ok": True,
            "code": "search_ok",
            "message": "已联网搜索：1 条结果",
            "model_content": f"query={args.get('query')} user={user_text}",
        }

    async def fetch_from_tool(self, args):
        return {
            "ok": True,
            "code": "fetch_ok",
            "message": "已抓取网页",
            "model_content": f"url={args.get('url')}",
        }


def test_default_registry_registers_search_tools() -> None:
    registry = build_default_registry(search=FakeSearchServiceTools())
    assert [s.name for s in registry.all()] == [
        "open_settings",
        "open_work",
        "web_search",
        "web_fetch",
    ]
    search = registry.get("web_search")
    assert search is not None
    assert search.executor == "backend"
    assert search.feedback is True
    assert search.needs_user_text is True
    assert search.handler is not None
    result = asyncio.run(search.handler({"query": "V4"}, "搜一下 V4"))
    assert result["code"] == "search_ok"
    assert "query=V4" in result["model_content"]

    fetch = registry.get("web_fetch")
    assert fetch is not None and fetch.feedback is True
    assert fetch.handler is not None
    result = asyncio.run(fetch.handler({"url": "https://example.com"}))
    assert result["code"] == "fetch_ok"


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


@pytest.mark.parametrize("text", ["打开工作模式", "帮我打开工作台", "进入工作模式。"])
def test_match_directive_open_work(text: str) -> None:
    """工作模式入口：必须带“打开/进入”动词，避免提问被误判成开窗。"""
    assert match_directive(text) == "open_work"


@pytest.mark.parametrize("text", ["什么是工作模式？", "工作模式有什么用", "工作台"])
def test_match_directive_work_question_misses(text: str) -> None:
    assert match_directive(text) is None


# ---------------------------------------------------------------- 强制工具意图（提醒）


@pytest.mark.parametrize(
    "text",
    [
        "1分钟后提醒我睡觉",
        "一分钟后提醒我睡觉",
        "12点3分提醒我睡觉",
        "明天 9 点提醒我交房租",
        "每天 8 点提醒我吃药",
        "半小时后叫我起床",
        "10:30 提醒我开会",
        "记得明天9点提醒我开会",
    ],
)
def test_match_forced_tool_hits_create_reminder(text: str) -> None:
    """动作 + 明确时间 → 强制 create_reminder（真机模型曾只说不做）。"""
    assert match_forced_tool(text) == "create_reminder"


@pytest.mark.parametrize(
    "text",
    [
        "提醒我交房租",  # 没时间：应先反问“什么时候”
        "明天提醒我交房租",  # 只有日期、没有钟点：仍应先问几点
        "每天晚上提醒我吃药",
        "下周一提醒我开会",
        "提醒我怎么用",
        "你能提醒我吗",
        "我有哪些提醒",
        "取消明天9点的提醒",
        "提醒功能怎么用",
        "",
    ],
)
def test_match_forced_tool_misses(text: str) -> None:
    """没有明确时间 / 不是创建动作：不强制，保留模型反问的空间。"""
    assert match_forced_tool(text) is None


# ---------------------------------------------------------------- 强制工具意图（记忆本）


@pytest.mark.parametrize(
    "text",
    [
        "记住这个链接 https://example.com/a",
        "帮我记住我的生日是 5 月 3 日",
        "记一下：我的快递单号是 SF123456789",
        "收藏一下这段话",
        "把这个存到记忆本 https://example.com",
        "记住这个链接好吗 https://example.com",
    ],
)
def test_match_forced_tool_hits_save_item(text: str) -> None:
    """明确的保存指令 → 强制 save_item（防模型只口头答应“记住了”）。"""
    assert match_forced_tool(text) == "save_item"


@pytest.mark.parametrize(
    "text",
    [
        "记住我叫什么了吗",
        "你还记得我的生日吗",
        "我记住了",
        "没记住这个链接 https://example.com",
        "不用记住这个链接 https://example.com",
        "记住明天提醒我",
        "记住这个链接，提醒我明天看 https://example.com",
        "这个东西很好看",
        "把那个删了",
        "",
    ],
)
def test_match_forced_tool_does_not_force_save_item(text: str) -> None:
    """疑问 / 闲聊 / 非保存指令：不强制，交给模型判断。"""
    assert match_forced_tool(text) != "save_item"


def test_reminder_has_priority_over_save_item() -> None:
    """“记住明天 9 点提醒我”是提醒，不是记忆本保存。"""
    assert match_forced_tool("记住明天9点提醒我开会") == "create_reminder"
