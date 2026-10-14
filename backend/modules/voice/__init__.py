"""voice 模块（Phase 2 语音链路，设计文档 §4.4）。

- ``splitter``：流式分句器（LLM 文本流 → 完整句子）；
- ``tts``：TTS provider 抽象与实现（Edge TTS）。

依赖方向：modules 不依赖 interfaces / application（纯能力层）。
"""
