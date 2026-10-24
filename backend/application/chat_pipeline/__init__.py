"""对话流水线（真 LLM 版 + 语音链路）。

一轮对话的用户可见事件流，严格按设计文档 §7.1 时序编排：

    user_message
      → state:thinking → reply_start → token / emotion（流式）
          └─ 干净文本同时喂 splitter → 完整句：sentence 事件 + TTS 任务
                                        → 合成完推二进制音频帧（§3.5）
      →（等待本轮语音帧全部送出）→ reply_end → state:idle

- 与 WS 协议解耦：通过出站端口 ReplySink 输出，由 interfaces/ws 实现为协议事件；
- 情绪标签解析交给 modules/chat/emotion（跨片段切分安全）；
- 分句交给 modules/voice/splitter（跨片段边界安全）；
- TTS 编排交给 application/voice（连接级 VoiceOut + 轮级 ReplyVoice）；
- LLM 由注入的 LLMProvider 提供（生产：OpenAICompatProvider；测试：tests/fakes.py）；
- 对话历史：由 application.session.Session 维护最近 N 轮，并增量落库；
- 记忆注入（P3）：``PromptBuilder.build_messages`` 在 system(人格) 之后追加
  一段 system(画像 + 召回记忆)——有内容才注入；召回失败只降级、不阻断对话；
- ``state:thinking`` 在发起 LLM 请求**之前**推送——推理型模型的思考耗时真实存在；
- LLM 失败（LlmError）：以已产出文本收尾 reply_end，再推 error 事件提示原因；
- TTS 失败：单句失败跳过该句；连续失败达阈值由语音层停用本次连接的 TTS；
- 工具机制（§4.7）三层保底：快通道（指令词表，不调 LLM）→ 模型 tools 路径
  （frontend 型 reply_end 后派发 tool_call；backend 型当场执行并以 notice 推送）→
  tools 被网关拒绝时摘除重放并置进程级降级标记；
- 联网搜索/抓取（feedback 工具）：流末把结果回喂模型，再跑一轮生成最终回答。

目录分工：

- ``pipeline.py``：ChatPipeline 与一轮对话的编排；
- ``prompts.py``：system 段落、记忆/记忆本注入、文件限额与上下文预算；
- ``tools.py``：快通道、工具定义筛选、执行分流与结果收口；
- ``stream.py``：LLM 流消费与降级重放；
- ``emitter.py``：token/情绪推送与一次性提示；
- ``types.py``：TurnOptions 与 ReplySink。
"""

from backend.application.chat_pipeline.pipeline import ChatPipeline
from backend.application.chat_pipeline.tools import (
    FALLBACK_ACK,
    reset_tools_support_state,
)
from backend.application.chat_pipeline.types import ReplySink, TurnOptions

# 测试沿用的旧模块级私有名（保持用例零改动）
_FALLBACK_ACK = FALLBACK_ACK
_reset_tools_support_state = reset_tools_support_state

__all__ = [
    "ChatPipeline",
    "FALLBACK_ACK",
    "ReplySink",
    "TurnOptions",
    "reset_tools_support_state",
]
