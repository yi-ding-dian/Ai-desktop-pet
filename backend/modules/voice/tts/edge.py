"""Edge TTS 实现（设计文档 §4.4：v1 采用 Edge TTS——免费、用户零配置）。

- 输出格式：edge-tts 默认 ``audio-24khz-48kbitrate-mono-mp3``（24kHz 单声道），
  与协议头 ``sample_rate: 24000`` 一致（§3.5）；
- 风险登记（§4.4）：Edge TTS 为非官方接口，可能失效；网络/上游异常统一
  翻译成业务化 TtsError，上层只做降级处理，不感知 edge-tts 细节。
"""

from __future__ import annotations

import asyncio

import edge_tts

from backend.modules.voice.tts.provider import TTSProvider
from backend.shared.errors import TtsError, TtsErrorCode

#: 默认中文音色（可从 config.toml [voice].voice 覆盖）
DEFAULT_VOICE = "zh-CN-XiaoxiaoNeural"


class EdgeTTSProvider:
    """Edge TTS provider（每次 synthesize 建立一次合成会话）。"""

    def __init__(
        self,
        *,
        voice: str = DEFAULT_VOICE,
        rate: str = "+0%",
        volume: str = "+0%",
        pitch: str = "+0Hz",
        connect_timeout: int = 10,
        receive_timeout: int = 30,
    ) -> None:
        self._voice = voice
        self._rate = rate
        self._volume = volume
        self._pitch = pitch
        self._connect_timeout = connect_timeout
        self._receive_timeout = receive_timeout

    async def synthesize(self, text: str) -> bytes:
        """合成一句话，返回完整 mp3 字节；失败抛 TtsError（不泄漏底层异常细节）。"""
        buf = bytearray()
        try:
            # 注意：edge-tts 要求 connect/receive timeout 为 int（7.x 校验）
            communicate = edge_tts.Communicate(
                text,
                self._voice,
                rate=self._rate,
                volume=self._volume,
                pitch=self._pitch,
                connect_timeout=self._connect_timeout,
                receive_timeout=self._receive_timeout,
            )
            async for chunk in communicate.stream():
                if chunk.get("type") == "audio":
                    buf.extend(chunk["data"])
        except asyncio.CancelledError:
            raise  # 打断（cancel 链）不得被翻译成业务错误
        except Exception as exc:
            raise TtsError(
                TtsErrorCode.TTS_NETWORK,
                f"Edge TTS 合成失败（{type(exc).__name__}），请检查网络后重试",
            ) from exc

        if not buf:
            raise TtsError(TtsErrorCode.TTS_EMPTY, "Edge TTS 返回空音频")
        return bytes(buf)


__all__ = ["EdgeTTSProvider", "DEFAULT_VOICE", "TTSProvider"]
