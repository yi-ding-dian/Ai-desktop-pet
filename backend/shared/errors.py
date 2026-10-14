"""错误码与协议层异常。

错误码对应 WS 协议 error 事件的 code 字段（设计文档 §3.3）。
"""

from __future__ import annotations

from enum import StrEnum


class ErrorCode(StrEnum):
    """WS 协议错误码。"""

    BAD_MESSAGE = "BAD_MESSAGE"            # 消息解析失败 / 字段校验不过
    UNKNOWN_TYPE = "UNKNOWN_TYPE"          # 协议外的未知事件类型
    NOT_IMPLEMENTED = "NOT_IMPLEMENTED"    # 协议内、但当前版本尚未实现
    HELLO_REQUIRED = "HELLO_REQUIRED"      # 未完成 hello 鉴权就发送其它消息
    AUTH_FAILED = "AUTH_FAILED"            # token 校验失败
    VERSION_MISMATCH = "VERSION_MISMATCH"  # 协议版本不匹配
    INTERNAL = "INTERNAL"                  # 服务端内部错误


class ProtocolError(Exception):
    """协议层错误：interfaces/ws 解析或处理消息时抛出，统一转成 error 事件。

    fatal=True 表示发送 error 后连接将被关闭（如鉴权失败、版本不匹配）。
    """

    def __init__(self, code: ErrorCode, message: str, *, fatal: bool = False) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.fatal = fatal
