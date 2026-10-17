"""文件域（文件分析 P1）：读取用户显式选择的本地文本/代码文件。

职责边界：
- **只读**：不执行文件内容、不写用户文件；不把绝对路径透露给模型；
- 读取与限额（大小 / 字数 / 本轮数量）收敛在 ``reader``，协议/流水线不重复实现；
- 文本注入的拼接与 token 估算收敛在 ``budget``，保证"先估算再决定丢历史/拒绝"。
"""

from backend.modules.files.budget import (
    build_attachment_block,
    build_attachment_user_content,
    estimate_messages_tokens,
    estimate_tokens,
)
from backend.modules.files.reader import (
    FileAttachment,
    FileLimits,
    FileRef,
    FileRejected,
    read_attachments,
)

__all__ = [
    "FileAttachment",
    "FileLimits",
    "FileRef",
    "FileRejected",
    "build_attachment_block",
    "build_attachment_user_content",
    "estimate_messages_tokens",
    "estimate_tokens",
    "read_attachments",
]
