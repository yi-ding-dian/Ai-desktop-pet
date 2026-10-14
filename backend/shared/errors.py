"""错误码与异常定义。

- ``ErrorCode``：WS 协议错误码，对应 error 事件的 code 字段（设计文档 §3.3）；
- ``LlmErrorCode``：LLM 调用错误码（§4.1 要求"超时/重试/错误码翻译统一在 llm 层，
  对上层只暴露业务化错误"），同样走 error 事件的 code 字段。
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
    TTS_FAILED = "TTS_FAILED"              # 语音合成连续失败，本次连接内已停用 TTS（非 fatal）


class LlmErrorCode(StrEnum):
    """LLM 调用错误码（经 error 事件透传给前端展示）。"""

    LLM_NO_KEY = "LLM_NO_KEY"            # 未配置 API key（引导用户去设置面板）
    LLM_AUTH = "LLM_AUTH"                # key 无效 / 无权限（401/403）
    LLM_TIMEOUT = "LLM_TIMEOUT"          # 请求超时
    LLM_NETWORK = "LLM_NETWORK"          # 网络不可达 / 连接失败
    LLM_RATE_LIMIT = "LLM_RATE_LIMIT"    # 触发限流（429）
    LLM_BAD_REQUEST = "LLM_BAD_REQUEST"  # 请求被拒（模型名不存在 / 参数不合法，400/404）
    LLM_UPSTREAM = "LLM_UPSTREAM"        # 上游服务错误（5xx / 其它未分类）


class ProtocolError(Exception):
    """协议层错误：interfaces/ws 解析或处理消息时抛出，统一转成 error 事件。

    fatal=True 表示发送 error 后连接将被关闭（如鉴权失败、版本不匹配）。
    """

    def __init__(self, code: ErrorCode, message: str, *, fatal: bool = False) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.fatal = fatal


class LlmError(Exception):
    """LLM 业务化错误：provider 层把 SDK 异常翻译成它，上层（chat_pipeline）
    捕获后以 error 事件透传；message 必须已脱敏（不含 key 明文）。
    """

    def __init__(self, code: LlmErrorCode, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


class TtsErrorCode(StrEnum):
    """TTS 合成错误码（在日志与降级判定中使用；不透传单句错误到前端）。"""

    TTS_NETWORK = "TTS_NETWORK"  # 网络不可达 / 连接失败 / 上游异常
    TTS_TIMEOUT = "TTS_TIMEOUT"  # 单句合成超时
    TTS_EMPTY = "TTS_EMPTY"      # 合成结果为空（上游异常返回）


class TtsError(Exception):
    """TTS 业务化错误：provider 层把 edge-tts / 网络异常翻译成它。

    单句失败由语音编排层（application/voice.py）降级处理：跳过该句、累计
    连续失败次数，不向上抛（不打断对话）。
    """

    def __init__(self, code: TtsErrorCode, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
