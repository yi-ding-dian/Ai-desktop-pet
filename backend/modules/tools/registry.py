"""工具注册表（§4.7 工具机制）：工具定义 + OpenAI 协议转换。

本域是"内置工具"的唯一事实来源：chat 管道（application 层）从这里取
本轮可用工具、转 OpenAI ``tools`` 参数；工具名 → 执行方的映射也在这里。

与 llm 域的边界：本域保存 ``parameters`` 的原始 JSON Schema，转协议格式时
保持原样；llm 域只收 ``list[dict]``（不 import 本域，见 openai_compat.py）。

``executor`` 取值（§4.7）：

- ``"frontend"``：由前端执行（如 open_settings → 打开设置窗）。助手侧只需
  把工具名与参数经 WS 下发（``ToolCallData``），不产生回执依赖；
- ``"backend"``：由后端执行——chat 管道在 ``reply_end`` 前同步/异步调用
  ``handler(args)``，结果以确定性 ``notice`` 回给聊天区（提醒工具即此型，
  2026-10-18 起启用）。

``handler`` 接受一个参数字典，返回 dict（``{"ok": bool, "code": str, "message": str}``）。
允许返回 awaitable（handler 本身是普通函数、内部返回协程即可，当前提醒工具为同步）。
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable


@dataclass(frozen=True)
class ToolSpec:
    """一个内置工具的静态定义。

    - ``name`` / ``description`` / ``parameters``：发给模型的函数签名
      （``parameters`` 为 JSON Schema，须是 object 型）；
    - ``executor``：执行方（"frontend" / "backend"，见模块 docstring）；
    - ``handler``：backend 型工具的执行函数（frontend 型为 None）；
    - ``ack``：工具执行后"模型没说话时"的确认话兜底文案（chat 管道取用）——
      模型只回 tool_calls 不产出正文时，用它补一句口语回应，避免用户端静默；
    - ``prepare``：**frontend 型工具的前置解析**——chat 管道在 ``reply_end``
      之后派发 ``tool_call`` 前调用 ``prepare(args, user_text)``。返回
      ``{"ok": True, "args": {...}}`` 时用解析后的参数派发；返回
      ``{"ok": False, "code": "...", "message": "..."}`` 时作为后端结果发通知、
      不派发。用于"名字 → 精确值"的解析（记忆本 open_item / delete_path）：
      模型只传名字，URL/路径由后端取，避免抄错；同时可校验用户本轮原话
      （防文件/网页内容诱导操作）。
    - ``needs_user_text``：backend 型 handler 是否额外接收用户本轮原话
      （``handler(args, user_text)``）。记忆本删除记录需要判断"用户是否点名/
      指的是删记录还是删文件"。
    """

    name: str
    description: str
    parameters: dict[str, Any]
    executor: str = "frontend"
    handler: Callable[..., Any] | None = None
    ack: str = ""
    prepare: Callable[[dict[str, Any], str], dict[str, Any]] | None = None
    needs_user_text: bool = False


class ToolRegistry:
    """工具注册表：注册 / 查询 / 转 OpenAI 协议格式。

    注册表由 application 装配层在启动时构建（``build_default_registry``），
    之后只读使用；本类不做并发保护——本期装配后不再变更。
    """

    def __init__(self) -> None:
        self._specs: dict[str, ToolSpec] = {}

    def register(self, spec: ToolSpec) -> None:
        """注册一个工具；重名抛 ValueError（早暴露装配错误，而不是静默覆盖）。"""
        if spec.name in self._specs:
            raise ValueError(f"工具重名：{spec.name} 已注册，不能重复注册")
        self._specs[spec.name] = spec

    def get(self, name: str) -> ToolSpec | None:
        """按名取工具定义；未注册返回 None（调用方按"未知工具"各自处置）。"""
        return self._specs.get(name)

    def all(self) -> list[ToolSpec]:
        """全部工具（注册顺序——即发给模型的声明顺序）。"""
        return list(self._specs.values())

    def to_openai_tools(self) -> list[dict[str, Any]]:
        """转 OpenAI 协议 ``tools`` 参数（chat.completions 请求体格式）：

            [{"type": "function", "function": {name, description, parameters}}]

        ``parameters`` 原样携带（本域不改写 JSON Schema）。
        """
        return [
            {
                "type": "function",
                "function": {
                    "name": spec.name,
                    "description": spec.description,
                    "parameters": spec.parameters,
                },
            }
            for spec in self._specs.values()
        ]
