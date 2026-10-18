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

    背景（2026-10-18 真机缺陷）：模型对“1 分钟后提醒我睡觉”这类请求会随机
    只回一句“好，提醒你”，却不真正调用 ``create_reminder``——用户以为设上了，
    到点没有提醒。对“提醒动作 + 明确时间”这种高置信度意图，调用方用
    ``tool_choice`` 强制指定工具，把“模型自选”变成“必须调用”。

    只覆盖 create_reminder：取消/查看提醒需要先确定目标或列表，强行调用反而
    会打断模型的反问，暂不强制。
    """
    content = (text or "").strip()
    if not content:
        return None
    if _REMINDER_ACTION.search(content) and _REMINDER_TIME.search(content):
        return "create_reminder"
    return None
