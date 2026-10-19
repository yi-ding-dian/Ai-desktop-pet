"""内置指令词表（快通道，§4.7）：用户输入 → 工具名的确定性匹配。

为什么需要快通道：模型调用工具存在不确定性（可能只给文字步骤而不实际调用、
或在网关不支持 tools 时完全失效）；对"打开设置"这类高频、意图明确的指令，
用本地词表直接命中、绕过模型，保证必达。

词表从迁移前的前端实现平移（原 frontend/src/modules/teaching/index.ts 的
SETTINGS_KEYWORDS ``/打开设置|设置面板/``，已由前端侧回收）：**包含匹配**
（re.search，与前端行为一致——"帮我打开设置面板"也要命中）。

结构上是"正则 → 工具名"的有序表：将来加指令（如"打开黑板"）在
``_DIRECTIVES`` 追加一行即可；命中即返回（先到先得）。
"""

from __future__ import annotations

import re

#: 指令词表：每项为 (匹配正则, 目标工具名)。顺序即优先级。
_DIRECTIVES: tuple[tuple[re.Pattern[str], str], ...] = (
    (re.compile(r"打开设置|设置面板"), "open_settings"),
    # 动词锚定：避免“什么是工作模式”这类提问被误判成开窗指令
    (re.compile(r"打开工作模式|打开工作台|进入工作模式"), "open_work"),
)

#: 提醒意图里的“动作”：明确在让宠物提醒/叫醒自己。
_REMINDER_ACTION = re.compile(
    r"提醒我|提醒一下|到.{0,6}提醒|叫我|记得.{0,8}(?:提醒|叫我)"
)
#: 提醒意图里的“时间”：必须有**具体钟点/时长**才强制调用。
#: 只有“明天/晚上/每天”这类模糊日期时不强制——模型应先追问几点，
#: 强制调用只会让它猜一个时间，或带着空 due_at 去设而失败。
_REMINDER_TIME = re.compile(
    r"(?:\d|[零一二三四五六七八九十两半]+)\s*(?:点|分钟|分|小时|天)"
    r"|\d{1,2}[:：]\d{2}"
)

#: 记忆本保存**不再走强制路由**（2026-10-19 用户拍板“大模型做路由”）。
#: 原因：偏好/事实（“记住我爱吃鱼”）与精确条目（链接/路径/编号）的边界靠正则
#: 无法穷举，交给模型按 capabilities.md 的边界判断；模型仍可自行调用 save_item。
#: 历史背景：2026-10-18 曾因模型“只口头答应、不真正调用”而强制 save_item，
#: 本次移除；若后续复现漏存，再加轻量兜底而不是恢复无差别硬强制。


def match_directive(text: str) -> str | None:
    """在用户输入中匹配内置指令词表；命中返回工具名，未命中返回 None。

    包含匹配（与迁移前前端正则行为一致）；不做分词 / 不区分大小写需求
    （当前词表全中文）。
    """
    for pattern, tool_name in _DIRECTIVES:
        if pattern.search(text):
            return tool_name
    return None


def match_forced_tool(text: str) -> str | None:
    """返回本轮应当**强制**调用的工具名；无则 None。

    只覆盖 ``create_reminder``：提醒动作 + 明确时间——模型曾只回“好，提醒你”
    却不真正创建，用户以为设上了、到点没有提醒（2026-10-18 真机复现）。

    记忆保存**不强制**（2026-10-19）：偏好/事实/经历与链接/路径/编号的边界交给
    模型按提示词判断，模型仍可自行调用 save_item；疑问句、闲聊、非保存指令不干预。
    """
    content = (text or "").strip()
    if not content:
        return None
    if _REMINDER_ACTION.search(content) and _REMINDER_TIME.search(content):
        return "create_reminder"
    return None
