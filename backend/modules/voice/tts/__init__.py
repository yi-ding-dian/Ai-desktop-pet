"""TTS provider 包：抽象（provider.py）+ 实现（edge.py）+ 组装工厂。"""

from __future__ import annotations

from backend.modules.voice.tts.edge import DEFAULT_VOICE, EdgeTTSProvider
from backend.modules.voice.tts.provider import TTSProvider


def create_tts_provider(*, provider: str, voice: str = DEFAULT_VOICE) -> TTSProvider:
    """按配置构造 TTS provider（provider 可插拔点，§4.4）。

    未知 provider 抛 ValueError——由装配处（main.py）捕获并记日志降级，
    不阻断后端启动（语音是旁路能力）。
    """
    if provider == "edge":
        return EdgeTTSProvider(voice=voice or DEFAULT_VOICE)
    raise ValueError(f"未知的 TTS provider：{provider!r}（可选：edge）")


__all__ = ["TTSProvider", "EdgeTTSProvider", "DEFAULT_VOICE", "create_tts_provider"]
