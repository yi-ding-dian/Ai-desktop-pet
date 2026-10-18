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

#: 记忆本保存意图（2026-10-18）：用户明确说“记住/记一下/收藏”。
#: 与提醒一样，模型会偶发“只嘴上答应、不真正调用工具”，对明确的保存指令用
#: tool_choice 强制调用 save_item。词表只做“意图识别”，具体条目/名字仍由模型填。
_REMEMBER_ACTION = re.compile(r"记住|记一下|记下|收藏|存到记忆本|记到记忆本")
#: 句首/标点后的保存动作（排除“你记得吗”“记住我叫什么了吗”这类疑问/闲聊）
_REMEMBER_START = re.compile(
    r"(?:^|[，。！？；\s])(?:请|帮我|麻烦)?(?:记住|记一下|记下|收藏|存到记忆本|记到记忆本)"
)
_URL_RE = re.compile(r"https?://\S+", re.IGNORECASE)
#: 否定表达（“没记住/不用记住/别收藏”）不是保存指令——即使带链接也不强制
_REMEMBER_NEGATIVE = re.compile(r"(?:没|不|别|不用|不想|无需|不要)(?:用)?(?:记住|记下|记一下|收藏)")


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

    覆盖两类高置信度意图（其余仍由模型自选，避免打断反问）：

    1. ``create_reminder``：提醒动作 + 明确时间——模型曾只回“好，提醒你”却不
       真正创建，用户以为设上了、到点没有提醒（2026-10-18 真机复现）；
    2. ``save_item``：明确的“记住/记一下/收藏”保存指令（句首动作，或带 URL）
       ——同理，模型可能只口头答应“记住了”，实际没写进记忆本。

    疑问句（“……吗/呢/？”）且没有链接时不强制（“记住我叫什么了吗”是在问，
    不是让保存）。取消/查看/打开/删除需要先确定目标或列表，强行调用会打断
    模型的反问，暂不强制。
    """
    content = (text or "").strip()
    if not content:
        return None
    has_url = _URL_RE.search(content) is not None
    if _REMINDER_ACTION.search(content) and _REMINDER_TIME.search(content):
        return "create_reminder"
    if _REMINDER_ACTION.search(content):
        # 有提醒意图但没有明确时间：让模型反问“几点”，或自行编排“保存 + 提醒”
        # 两个工具；此时强制 save_item 会抢掉提醒意图。
        return None
    if _REMEMBER_NEGATIVE.search(content):
        return None
    if _REMEMBER_START.search(content) or (_REMEMBER_ACTION.search(content) and has_url):
        if not has_url and content.endswith(("吗", "呢", "？", "?")):
            return None
        return "save_item"
    return None
