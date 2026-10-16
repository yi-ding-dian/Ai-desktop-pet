"""工具注册表（§4.7 工具机制）：工具定义 + OpenAI 协议转换。

本域是"内置工具"的唯一事实来源：chat 管道（application 层）从这里取
本轮可用工具、转 OpenAI ``tools`` 参数；工具名 → 执行方的映射也在这里。

与 llm 域的边界：本域保存 ``parameters`` 的原始 JSON Schema，转协议格式时
保持原样；llm 域只收 ``list[dict]``（不 import 本域，见 openai_compat.py）。

``executor`` 取值（§4.7）：

- ``"frontend"``：由前端执行（如 open_settings → 打开设置窗）。助手侧只需
  把工具名与参数经 WS 下发（``ToolCallData``），不产生回执依赖；
- ``"backend"``：由后端执行（``handler`` 为执行函数）——为将来后端型工具
  （如记忆查询）预留；本期内置工具均为 frontend 型。

``handler`` 为何用普通 Callable 而非 async：本期无 backend 型工具、执行路径
（谁在哪调度）尚未定稿；先保留注入缝、由调用方按需约定（避免过早绑定调度
模型）。真正的调度实现属"结果回传续写"阶段。
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
      模型只回 tool_calls 不产出正文时，用它补一句口语回应，避免用户端静默。
    """

    name: str
    description: str
    parameters: dict[str, Any]
    executor: str = "frontend"
    handler: Callable[..., Any] | None = None
    ack: str = ""


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
