"""工具机制（§4.7）：快通道命中、工具定义筛选、执行分流与结果收口。"""

from __future__ import annotations

import inspect
import json
import uuid
from typing import Any

from loguru import logger

from backend.application.chat_pipeline.prompts import SEARCH_TOOL_NAMES
from backend.modules.tools import ToolRegistry, ToolSpec, match_directive

#: 工具 ack 为空时的通用兜底文案（§4.7）
FALLBACK_ACK = "好嘞，已经帮你办好啦～"

#: 进程级降级标记（§4.7）：带 tools 的请求被 LLM_BAD_REQUEST 拒绝且本轮无产出
#: （疑似网关/模型不支持 tools）→ 置位后本进程后续轮不再携带 tools。
#: 为什么用模块变量：降级结论对"这个网关 + 模型"是进程级事实，跨连接/跨会话共享；
#: 快通道（内置指令词表）不依赖模型 tools 能力，不受该标记影响、照常可用。
_tools_unsupported = False


def forced_tool_missed_notice(tool_name: str | None) -> tuple[str, str]:
    """强制 tool_choice 后模型仍未返回该工具时的用户提示（按工具区分文案）。"""
    if tool_name == "create_reminder":
        return ("reminder_tool_missed", "这条提醒可能没设上：我这边没收到创建指令，再说一次好吗？")
    return ("tool_call_missed", "这个操作可能没完成：我这边没收到执行指令，再说一次好吗？")


def tools_unsupported() -> bool:
    return _tools_unsupported


def mark_tools_unsupported() -> None:
    """置位进程级降级标记（首次置位原因由调用点 logger.warning 说明）。"""
    global _tools_unsupported
    _tools_unsupported = True


def reset_tools_support_state() -> None:
    """重置进程级降级标记——仅供测试做用例间隔离（生产代码不调用）。"""
    global _tools_unsupported
    _tools_unsupported = False


def match_directive_spec(registry: ToolRegistry, user_text: str) -> ToolSpec | None:
    """用户输入命中内置指令词表且可走快通道时返回对应 ToolSpec，否则 None。

    仅 frontend 型工具可走快通道：backend 型需要模型给出的参数，不能由词表静默命中。
    """
    name = match_directive(user_text)
    if name is None:
        return None
    spec = registry.get(name)
    if spec is None:
        logger.warning("指令命中工具 {} 但注册表缺该定义（装配不一致），走正常流", name)
        return None
    if spec.executor != "frontend":
        logger.info("指令命中 backend 型工具 {}，改走模型正常流（需要参数）", name)
        return None
    return spec


def ack_for(registry: ToolRegistry | None, tool_name: str) -> str:
    """取工具的确认话术（spec.ack）；未注册 / 未配 ack 用通用兜底文案。"""
    spec = registry.get(tool_name) if registry is not None else None
    if spec is not None and spec.ack:
        return spec.ack
    return FALLBACK_ACK


def select_tool_defs(registry: ToolRegistry, *, search: bool) -> list[dict[str, Any]]:
    """本轮请求携带的工具定义（关闭智能搜索时只移除联网工具）。"""
    tool_defs = registry.to_openai_tools()
    if not search:
        tool_defs = [
            item
            for item in tool_defs
            if item.get("function", {}).get("name") not in SEARCH_TOOL_NAMES
        ]
    return tool_defs


async def execute_tool_calls(
    registry: ToolRegistry | None,
    calls: list[tuple[str, str, dict[str, Any]]],
    user_text: str,
) -> tuple[
    list[tuple[str, str, dict[str, Any]]], list[tuple[str, dict[str, Any]]]
]:
    """按 ``ToolSpec.executor`` 分流：返回 (前端调用, 后端结果)。

    - ``prepare``：派发前做"名字 → 精确值"解析与用户原话校验；失败转成后端通知；
    - 未注册 / frontend 型：原样交给前端（协议 tool_call）；
    - backend 型：在这里执行 handler，结果留给 notice。
    单个工具执行失败只记录、不阻断本轮对话。
    """
    frontend_calls: list[tuple[str, str, dict[str, Any]]] = []
    backend_results: list[tuple[str, dict[str, Any]]] = []
    for tool_id, name, args in calls:
        spec = registry.get(name) if registry is not None else None
        if spec is None:
            frontend_calls.append((tool_id, name, args))
            continue

        if spec.prepare is not None:
            try:
                prepared = spec.prepare(args, user_text)
                if inspect.isawaitable(prepared):
                    prepared = await prepared
            except Exception:
                logger.exception("工具 {} 前置解析异常", name)
                backend_results.append(
                    (
                        name,
                        {
                            "ok": False,
                            "code": "tool_prepare_failed",
                            "message": "这个操作没做成，再说一次好吗？",
                        },
                    )
                )
                continue
            if not isinstance(prepared, dict) or not prepared.get("ok"):
                result = prepared if isinstance(prepared, dict) else {}
                backend_results.append(
                    (
                        name,
                        {
                            "ok": False,
                            "code": str(result.get("code") or "tool_prepare_failed"),
                            "message": str(
                                result.get("message") or "这个操作没做成，再说一次好吗？"
                            ),
                        },
                    )
                )
                continue
            prepared_args = prepared.get("args")
            if isinstance(prepared_args, dict):
                args = prepared_args

        if spec.executor != "backend":
            frontend_calls.append((tool_id, name, args))
            continue
        result = await run_backend_tool(spec, args, user_text)
        if spec.feedback and result.get("model_content"):
            # 只有 feedback 工具需要回喂模型：带上调用 id/原参数
            result["_tool_call_id"] = tool_id
            result["_tool_args"] = args
        backend_results.append((name, result))
    return frontend_calls, backend_results


async def run_backend_tool(
    spec: ToolSpec, args: dict[str, Any], user_text: str
) -> dict[str, Any]:
    """执行一个 backend 型工具，把结果收敛为 ``{ok, code, message}``。"""
    if spec.handler is None:
        logger.warning("backend 型工具 {} 未配置 handler，按失败处理", spec.name)
        return {
            "ok": False,
            "code": "tool_error",
            "message": f"工具 {spec.name} 暂时不可用",
        }
    try:
        if spec.needs_user_text:
            result = spec.handler(args, user_text)
        else:
            result = spec.handler(args)
        if inspect.isawaitable(result):
            result = await result
    except Exception:
        logger.exception("backend 型工具 {} 执行异常", spec.name)
        return {
            "ok": False,
            "code": "tool_error",
            "message": "工具执行失败，请稍后再试",
        }
    if not isinstance(result, dict):
        logger.warning("backend 型工具 {} 返回值不是 dict：{!r}", spec.name, result)
        return {
            "ok": False,
            "code": "tool_error",
            "message": "工具返回了无法识别的结果",
        }
    normalized = {
        "ok": bool(result.get("ok")),
        "code": str(result.get("code") or "tool_result"),
        "message": str(result.get("message") or ""),
    }
    # 联网搜索/抓取：结果正文回喂模型（不进入用户通知），触发续写轮
    model_content = result.get("model_content")
    if isinstance(model_content, str) and model_content.strip():
        normalized["model_content"] = model_content
    # 搜索来源结构化信息：只给工作窗做引用悬浮卡片，不进入模型/通知
    sources = result.get("sources")
    if isinstance(sources, list):
        normalized["sources"] = sources
    return normalized


def compose_tool_ack(
    registry: ToolRegistry | None,
    frontend_calls: list[tuple[str, str, dict[str, Any]]],
    backend_results: list[tuple[str, dict[str, Any]]],
) -> str:
    """模型只调工具、没产出正文时补的那句话。"""
    for _name, result in backend_results:
        # 联网搜索/抓取的结果会回喂模型：失败原因由模型在续写轮说明
        if result.get("model_content"):
            continue
        if not result.get("ok") and result.get("message"):
            return str(result["message"])
    if frontend_calls:
        return ack_for(registry, frontend_calls[0][1])
    if backend_results:
        return ack_for(registry, backend_results[0][0])
    return FALLBACK_ACK


def collect_tool_calls(
    tool_acc: dict[int, dict[str, Any]],
) -> list[tuple[str, str, dict[str, Any]]]:
    """把按 index 归组的工具分片解析为 [(tool_id, name, args)]（按 index 序）。"""
    calls: list[tuple[str, str, dict[str, Any]]] = []
    for index in sorted(tool_acc):
        item = tool_acc[index]
        name = item["name"]
        if not name:
            logger.warning("工具调用分片缺 name（index={}），跳过派发", index)
            continue
        raw_args = (item["arguments"] or "").strip()
        args: dict[str, Any] = {}
        if raw_args:
            try:
                parsed = json.loads(raw_args)
            except json.JSONDecodeError:
                logger.warning("工具调用参数不是合法 JSON（name={}），按空参数派发", name)
            else:
                if isinstance(parsed, dict):
                    args = parsed
                else:
                    logger.warning("工具调用参数不是 JSON 对象（name={}），按空参数派发", name)
        calls.append((item["id"] or f"t_{uuid.uuid4().hex[:8]}", name, args))
    return calls
