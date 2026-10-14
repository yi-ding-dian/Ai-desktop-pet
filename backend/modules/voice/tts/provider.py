"""TTS provider 抽象（设计文档 §4.4；v1 按"一句话一帧"决策整句合成）。

与设计文档 §4.4 的差异说明：文档草案为流式 ``AsyncIterator[AudioChunk]``
（带 WordBoundary 时间戳供口型）；本步骤落地为**整句合成返回完整 mp3 字节**
（核心协议决策：一句话一帧，见 §3.5）。后续若需要口型时间戳，
在本 Protocol 上加新方法即可（provider 可插拔，调用方零改动）。
"""

from __future__ import annotations

from typing import Protocol, runtime_checkable


@runtime_checkable
class TTSProvider(Protocol):
    """语音合成 provider：给定一句文本，返回整句音频（mp3 字节）。"""

    async def synthesize(self, text: str) -> bytes:
        """合成一句话；失败抛 shared.errors.TtsError（业务化、已脱敏）。"""
        ...
