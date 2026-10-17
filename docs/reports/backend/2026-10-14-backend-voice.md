# P2 步骤 1：后端语音链路（TTS 流水线）实施报告

日期：2026-10-14　范围：`backend/`（未触碰 `frontend/`、`代码设计文档/`、`record.md`；未提交版本控制）

---

## 1. 状态

**完成**。149 项 pytest 全绿（原 109 项无回归 + 新增 40 项）；两条真实冒烟通过
（`voice_smoke.py` 全链路 6 句 6 帧、`ws_smoke.py` 三轮对话语音共存）；真实打断链路
验证通过（interrupt → TTS 取消 → `reply_end{interrupted}` → 静默无新帧）。

---

## 2. 改动清单

### 新增

| 文件 | 内容 |
|---|---|
| `backend/modules/voice/__init__.py` | 包说明 |
| `backend/modules/voice/splitter.py` | **流式分句器**（本次核心算法）：强边界（。！？；… .!?; 换行）遇即切；弱边界（逗号/顿号/冒号）片段 strip 后 ≥6 字才切（防过碎合并、长句提前出声）；连续终止符吸收（？！/……）；收尾符吸收（含跨片段 lookahead 延迟一拍）；英文小数点保护（3.14） |
| `backend/modules/voice/tts/__init__.py` | `create_tts_provider` 工厂（provider 可插拔点） |
| `backend/modules/voice/tts/provider.py` | `TTSProvider` Protocol：`async def synthesize(text) -> bytes`（整句 mp3） |
| `backend/modules/voice/tts/edge.py` | `EdgeTTSProvider`：edge-tts 7.3.1（默认 `zh-CN-XiaoxiaoNeural`，24kHz 单声道 mp3 —— 与协议头 `sample_rate:24000` 一致）；异常统一翻译为业务化 `TtsError`（CancelledError 除外） |
| `backend/application/voice.py` | **语音出站编排**：`VoiceOut`（连接级：provider + 连续失败降级状态，阈值 3，超时 10s/句）+ `ReplyVoice`（轮级：asyncio 队列 + 单个 worker 任务串行合成、按序推帧；`finish()` 等排空、`cancel()` 清队列+取消 worker，幂等） |
| `backend/tests/test_splitter.py` | 分句器 21 项单测（跨片段/标点组合/过碎/小数点/flush/幂等） |
| `backend/tests/test_voice.py` | 语音编排与流水线集成 12 项（帧序、final、失败跳过、连续失败停用、打断取消、超时、无语音不变） |
| `backend/examples/voice_smoke.py` | **真实冒烟脚本**（A provider 直连 + B 全链路：帧逐字节校验 + mp3 落盘） |

### 修改

| 文件 | 内容 |
|---|---|
| `backend/shared/errors.py` | `ErrorCode.TTS_FAILED`（非 fatal）；`TtsErrorCode`（NETWORK/TIMEOUT/EMPTY）与 `TtsError` |
| `backend/interfaces/ws/protocol.py` | **`pack_audio_frame`**（4 字节大端头长 + UTF-8 JSON + 数据）、`unpack_audio_frame`、`make_audio_header`、常量（type/format/sample_rate） |
| `backend/interfaces/ws/server.py` | `ConnectionContext` 增加 `sentence` / `send_binary`（`websocket.send_bytes`，与文本帧共用 `_send_lock`）与可选 `voice`；`create_app(voice_factory=...)` 每连接构造 `VoiceOut` |
| `backend/application/chat_pipeline.py` | 集成：干净文本喂 splitter → 完整句推 `sentence` 事件 + 入 TTS 队列；流结束 flush → `mark_final` → `await finish()`（**全部音频帧先于 reply_end**）；取消链中先 `voice.cancel()` 再推 `reply_end{interrupted}`；`ReplySink` 增加 `sentence`/`send_binary` 端口；`run_turn(..., voice=None)`（不传时行为与 P1 完全一致） |
| `backend/interfaces/ws/dispatcher.py` | `user_message` 传 `ctx.voice`；`interrupt` 注释阐明取消链覆盖 TTS（已合成的帧不再推） |
| `backend/main.py` | 装配：`[voice]` 读取 → `create_tts_provider` → 每连接 `VoiceOut`（`functools.partial` 工厂）；未知 provider 记日志降级不阻断启动 |
| `backend/shared/config.py` | `voice.enabled` 默认 **true**（模板 + `VoiceConfig`），任务书第 6 条 |
| `backend/pyproject.toml` | 依赖 + `edge-tts`；packages 补 `backend.modules.voice(.tts)`（另补了原列表遗漏的 `backend.modules.llm.prompts`） |
| `backend/tests/fakes.py` | `FakeTTSProvider`（记录调用、可注入延迟/失败）、`FAKE_MP3` |
| `backend/tests/test_protocol.py` | +7 项帧封装字节级测试（大端、头长、UTF-8、body 原样、非法帧拒绝） |
| `backend/tests/test_ws_e2e.py` | +2 项 e2e：语音帧全链路（真实 uvicorn + WS）、interrupt 停帧且连接可用 |
| `backend/tests/test_config.py` | 断言随 `voice.enabled=true` 更新 |
| `backend/examples/ws_smoke.py` | 兼容语音默认开启：容忍二进制帧（计数）+ `sentence` 事件；帧数 ≤ 句数（单句失败属设计降级） |

### 协议实现（与前端对齐，已交叉核对）

```
[4字节大端 N][JSON头 N 字节][mp3 数据]
{"type":"audio","message_id":"<回复id>","seq":<0起>,"format":"mp3","sample_rate":24000,"final":<最后一句>}
```

已只读核对前端 `shared/ws-client/binary-frame.ts`（大端 `getUint32(0,false)`、UTF-8 JSON、type/message_id 校验）
与 `modules/voice/audio-queue.ts`（message_id 分组 + seq 排序 + 打断 clear）——**格式与消费语义一致**。

---

## 3. 真实冒烟输出摘要（不含 key）

### 3.1 provider 直连（`voice_smoke.py` [A]）

```
text='你好呀，我是小豆。' 字节数=13680 耗时=0.97~1.01s
mp3 头=MPEG 帧同步 0xfff3 前4字节=ff f3 64 c4
```

### 3.2 全链路（真后端 + 真 LLM + 真 Edge TTS，两次通过）

```
[逐句] sentence #0 '你好呀！' … #5 '想到什么都可以跟我说，写代码也好、吐槽也好，我都在～'
[帧]   seq=0 final=False  7776 字节  ff f3 64 c4
       seq=1 final=False 21600 字节  …（共 6 帧，仅最后一帧 final=True）
       …
       seq=5 final=True  14544 字节  ff f3 64 c4
[摘要] sentence 数=6  音频帧数=6  总字节=83808
       seq=[0..5]  final=[F,F,F,F,F,T]  首帧时延（用户消息→首帧）=1.63s（另一次 1.97s）
[reply_end] interrupted=False（音频帧全部先于 reply_end 到达）
```

- 帧校验：4 字节大端头长正确、JSON 可解、字段齐全、`message_id` 与 `reply_start` 一致、payload 原样搬运；
- 音频校验：`python` 校验头 `ff f3`；`file` 命令：`MPEG ADTS, layer III, v2, 48 kbps, 24 kHz, Monaural`（与 `sample_rate:24000` 一致）；帧级 7.7KB~26.6KB（句长 1-3s 语音，大小合理）；合并音频已落盘 `/tmp/pet-voice-out-*/reply_combined.mp3`（可播放）。

### 3.3 打断（真实链路）

```
收到音频帧 #1（19999 字节）、#2（17983 字节） → 发送 interrupt
reply_end interrupted=True（full_text=已产出文本） → state idle
静默期 1.5s 无任何新帧 ✓（后续句子合成被取消，已合成的帧不再推）
```

（复现脚本：`/tmp/voice_interrupt_smoke.py`，临时文件未入库；可参考其流程补进
`voice_smoke.py` 的后续版本。）

### 3.4 降级真实验证（意外收获）

`ws_smoke` 一轮中出现 edge-tts **偶发单句合成失败**：后端日志
`TTS 合成失败（连续第 1 次，TtsError）：text='最爱喝拿铁咖啡～这些我可都记得清…'`，
该句被跳过，对话正常收尾（未达阈值不报错）——降级路径在真实环境验证有效。

---

## 4. 与设计文档的偏差

1. **§4.4 TTSProvider 接口**：文档草案为流式 `AsyncIterator[AudioChunk]`（含 WordBoundary 时间戳供口型）；
   按任务书核心协议决策落地为**整句合成 → bytes**（一句话一帧）。口型时间戳留待后续（可在 Protocol 上加方法）。
2. **§7.1 顺序细化**：在 `reply_end` 之前**等待本轮音频帧全部送出**（`voice.finish()`）——
   事件顺序集合不变，但 reply_end/state:idle 会推迟到音频推完后（尾句合成 ~0.5-1.5s）。
   换来的契约：**该回复的音频帧永不超过 reply_end**，前端收口无歧义；§7.2 打断语义更简单（取消链全覆盖）。
3. **sentence 事件的启用条件**：仅语音装配且未停用时推送；TTS 连续失败停用后停止推送后续 sentence
   （避免前端等待永远不会来的音频）。未装配语音时行为与 P1 完全一致（既有测试不变）。
4. **错误码**：新增 `TTS_FAILED`（§3.3 错误码表未定义 TTS 类，非 fatal；建议后续补进设计文档）。
5. **分层**：新增 `application/voice.py` 编排层（设计文档未定义位置）；`application` 直接使用
   `interfaces/ws/protocol.pack_audio_frame`（协议字节格式唯一事实来源在此，已在模块注释说明）。
6. **弱边界切分落地**：把"防过碎（<6 字合并）"实现为——逗号/顿号/冒号处片段 strip 后 ≥6 字即切
   （长句提前出声、降低单句 TTS 延迟），<6 字继续累积；强边界（终止标点）不受长度限制。
7. **`voice.enabled` 默认 true**（任务书第 6 条；设计文档 §6.3 模板原为 false）——配套更新 test_config 与 ws_smoke。

---

## 5. 坑与遗留

1. **edge-tts 偶发单句失败**（实测 1/3 轮出现 1 句）：当前按设计跳过；建议后续在 provider 层加 1 次
   重试（收益：偶发失败不至于丢句；成本：失败路径延迟 +1 次）。本次未做（任务书未要求，避免过度设计）。
2. **final 帧边缘**：若最后一句在 `mark_final` 调用前已被合成/发送（流末拖尾场景），该帧 `final=false`、
   无 final 帧。前端已核对：不依赖 final 封口（`reply_end`/stopAll 兜底），无实际影响；如需严格可后续在
   voice 层做"缺 final 时补发空 final 帧"（协议未定义空帧，暂不做）。
3. **"有 sentence 无帧"**：单句失败/停用场景下前端可能收到 sentence 但等不到音频；前端 player 有
   `clearExcept`/停止兜底（已只读核对）。
4. **英文缩写误切**（Mr. / e.g. / U.S.）与**弱边界切句的韵律停顿**：v1 有意简化，记录待后续打磨。
5. **跨片段收尾符**采用延迟一拍（lookahead）确认：句尾标点恰为片段末尾时，该句推迟到下一片段
   （或 flush）才切出，延迟约一个 LLM chunk（毫秒级），无感。
6. **打包（§8.2）遗留**：PyInstaller 需收集 `edge_tts`/`aiohttp` 的 hidden imports（未到打包步骤，备忘）。
7. edge-tts 7.3.1 的 `connect_timeout/receive_timeout` 必须是 int（float 会 TypeError）——已在 provider 修正并注释；
   同时 Communicate 构造纳入异常翻译范围（首次冒烟踩到后修复）。
8. 真实冒烟依赖：LLM 网关可达（http://192.168.0.8:3000）+ keyring 中的 key + 微软 edge 端点；
   本次全部可达。关键路径不打印任何 key 明文（沿用掩码）。
