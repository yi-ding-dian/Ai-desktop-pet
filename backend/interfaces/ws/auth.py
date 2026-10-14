"""hello 鉴权：token 校验（设计文档 §3.4 步骤 6）。"""

from __future__ import annotations

import hmac


def verify_token(provided: str | None, expected: str) -> bool:
    """常量时间比较 token，避免时序侧信道。"""
    if not provided or not expected:
        return False
    return hmac.compare_digest(provided.encode("utf-8"), expected.encode("utf-8"))
