# P2 前端语音（步骤 2）实施报告

> 日期：2026-10-14 ｜ 范围：`frontend/`（shared/protocol、shared/ws-client、modules/voice 新域、pet/chat 少量接线）
> 状态：**代码完成，自动化验证全部通过**；真声音 / 口型观感 / 打断体验列待用户确认（见 §4）

---

## 1. 结论

- 二进制音频帧（§3.5）已能收包解析并派发：`[4字节大端头长][JSON头][音频体]`，与后端
  `backend/interfaces/ws/protocol.py` 的 `pack_audio_frame` / `make_audio_header` **逐字段对齐**
  （已用后端打包的真实帧做交叉验证，含中文 message_id 往返）。
- voice 域（新）：播放队列（按 message_id 分组、组内 seq 排序、组间 FIFO、同一时刻只播一帧）+
  Web Audio 口型驱动（AnalyserNode 包络 → `PetRenderer.setMouth`）+ 打断（停播/清队列/闭嘴）。
- 打断闭环：ChatPanel「停止」按钮（说话/思考中显示）→ 发 `interrupt` + 本地立即静音；
  后端 `reply_end{interrupted}` 到达时再次清理（幂等）；`reply_start` 时清上一轮残留帧（防御）。
- 验证：typecheck 通过；Node 集成验证 **68 项断言 0 失败**；应用内端到端链路实跑通（日志+截图证据，§3.3）；
  HMR 无报错。

## 2. 改动清单

### 新增（全部在 frontend/）

| 文件 | 内容 |
|---|---|
| `src/shared/ws-client/binary-frame.ts` | §3.5 帧解析 `parseAudioFrame`：大端头长 → UTF-8 JSON 头 → payload slice；**坏帧返回 null 并记警告，绝不抛** |
| `src/modules/voice/audio-queue.ts` | 播放队列（纯数据结构）：message_id 分组 / seq 插入排序 / 组间 FIFO / `clear` / `clearExcept` |
| `src/modules/voice/lipsync.ts` | `MouthDriver`：MediaElementSource → AnalyserNode → destination；RMS → `rmsToLevel` → `smoothLevel`（上升快/下降慢，帧率无关）→ onLevel；停止时 `setMouth(0)`；纯函数可单测 |
| `src/modules/voice/player.ts` | `VoicePlayer`：`Blob(mp3)→URL.createObjectURL→HTMLAudioElement`；`playing` 事件接口型；`ended`/`error`/play() 被拒 → 释放 ObjectURL + 元素资源并推进下一帧（**失败不卡队列**）；`stopAll`/`dropOtherMessages` |
| `src/modules/voice/setup.ts` | 接线：`audio→enqueue`、`reply_start→清残留`、`reply_end{interrupted}→stopAll`；`subscribeVoiceSpeaking`（UI 用）；`stopVoiceNow`（停止按钮用）；dev 调试测试音与 `window.__petVoiceDebug` |
| `src/modules/voice/debug.ts` | 合成"说话感"测试音（16-bit PCM WAV，程序生成零素材）+ 假帧构造（format='wav'，仅调试） |
| `src/modules/voice/index.ts` / `util.ts` | 域出口 / 小工具 |
| `src/modules/pet/controller.ts` | pet 域模块级单例：`setActivePetRenderer`（PetView 注册）/ `setPetMouth`（voice 口型调用）；未挂载时空操作 |

### 修改

| 文件 | 改动 |
|---|---|
| `src/shared/protocol/index.ts` | 新增 `AudioFrameHeader` / `AudioFramePacket`；`ServerEventMap.audio` 指向 packet（二进制帧载荷，非信封 data）；删除空占位 `AudioData` |
| `src/shared/ws-client/index.ts` | `binaryType='arraybuffer'`；`handleMessage` 区分文本（JSON 事件）/二进制（`handleBinaryFrame` 解析后派发 `audio` 事件）；文本帧 audio 忽略（异常路径防御）；事件处理器第二参类型 `Envelope \| null`（二进制帧无信封；现有订阅者只用第一参，零破坏） |
| `src/modules/pet/PetView.tsx` | 挂载/卸载时注册/注销 controller（+2 行） |
| `src/modules/pet/index.ts` | 导出 controller 两函数 |
| `src/modules/pet/renderers/part-animation/index.ts` | `setMouth` 日志节流（变化 >0.12 或距上次 >500ms 才打印；口型驱动逐帧调用不再刷日志，调试键 M 仍即时可见） |
| `src/modules/chat/ChatPanel.tsx` | 「停止」按钮：`busy = speaking/thinking ‖ 本地语音在播 ‖ 回复流式中` 时显示；点击 = 发 `interrupt` + 本地立即静音 |
| `src/App.tsx` | `setupVoice(wsClient)` 接线（effect cleanup=退订+释放）；状态栏「🔊 说话中」；dev：V 键播放调试测试音 + 挂 `window.__petVoiceDebug` |
| `src/styles.css` | `.chat-stop`（红色小按钮）/ `.status-speaking` |

**未动**：`backend/`（仅只读核对）、`代码设计文档/`、`record.md`；未提交版本控制；未重启应用（全程 HMR）。

## 3. 验证结果

### 3.1 typecheck

```
npm run typecheck   # tsconfig.node + tsconfig.web 双配置，通过（无输出）
```

### 3.2 Node 集成验证：68 项断言 0 失败

临时脚本 `/tmp/voice-verify/run.ts`（一次性工具，不进版本控制）：esbuild 打包真实源码 +
对 WebSocket / HTMLAudioElement / AudioContext(analyser 固定正弦) / rAF / URL 做确定性 mock。

```
./node_modules/.bin/esbuild /tmp/voice-verify/run.ts --bundle --platform=node --format=esm \
  --outfile=/tmp/voice-verify/run.mjs --define:import.meta.env.DEV=false
node /tmp/voice-verify/run.mjs        # ===== 结果：68 通过 / 0 失败 =====
```

覆盖：

- **[1] 帧解析 8 项**：正常帧字段/字节逐一比对；头长越界、帧过短、坏 JSON、type≠audio → null 不抛。
- **[1b] 前后端交叉 4 项**：用后端 venv 跑 `pack_audio_frame` 生成真实帧（中文 message_id、883B）
  → 前端 `parseAudioFrame` 解析：字段与 payload 字节全部一致。
- **[2] 队列 7 项**：乱序 seq（2,0,1）出队升序；组间到达序；`clearExcept` 计数与保留；`clear`。
- **[3] 口型映射 3 项**：饱和、线性、上升快于下降。
- **[4] WsClient 派发 8 项**：`binaryType=arraybuffer`；hello_ack 后 connected；二进制帧 → `audio`
  订阅者收到 `{header,payload}` 且 envelope=null；坏帧不派发不崩；文本帧 audio 被忽略。
- **[5] VoicePlayer 全链路 24 项**：enqueue→建元素→`playing`→口型 level>0→`ended`→revokeObjectURL
  →src 清空→队列推进；同刻只播一个；**打断**（pause/mouth 归 0/不推进/URL 释放）；**play() 被拒**
  （无音频设备模拟）→ 释放后继续下一帧；`dropOtherMessages` 停止旧消息接续新消息。
- **[6] setupVoice 接线 8 项**：WS 音频帧 → 播放；speaking 订阅 true/false；`reply_start` 停旧残留；
  `reply_end{interrupted}` 立即停播。
- **[7] 调试 WAV 合成 3 项**：RIFF/WAVE 头、长度、PCM 非空。

> 验证过程中发现并修复 1 个真 bug：`stopAll` 后 `isSpeaking` 未复位（会导致打断后状态栏/按钮
> 一直显示"说话中"），已修 + 断言覆盖。

### 3.3 应用内端到端（真实 Chromium + 真实播放链路）

触发方式：`xdotool` 向宠物窗口发 V 键（等效用户按 V），播放合成测试音；全程日志来自主进程转发的
渲染进程 console（dev 终端 / `/tmp/pet-dev.log`）。

```
[voice] 帧入队 msg=debug-mv… seq=0 format=wav bytes=76844 final=true 队列=1
[voice] 开始说话
[voice] 开始播放 msg=debug-mv… seq=0
[voice] playing msg=debug-mv… seq=0            ← 播放元素 playing 事件触发（真实播放）
[voice] lipsync level=0.38 (rms=0.228)         ← 真实 Web Audio 包络（有音频数据流出）
[voice] lipsync level=0.81 (rms=0.033)
[voice] lipsync level=0.89 (rms=0.289)         ← level 动态波动（音节门控）
[pet] mouth -> 0.57 / 0.45 / 0.63 / 0.77 / 0.91 ← 播放期间 setMouth 被逐帧驱动（渲染器日志）
[voice] 回到待机（闭嘴）                        ← 结束清理
[pet] mouth -> 0.00                             ← 停止后闭嘴
```

点击「停止」按钮（xdotool 按截图坐标点击）：

```
[chat] interrupt 已发（sent=true），本地语音已停
[voice] 停止：清空播放与队列（点击停止按钮）
```

截图证据（`/tmp/voice-verify/shot-playing.png`）：播放期间「停止」按钮出现在发送按钮右侧、
状态栏显示「🔊 说话中」。

HMR：日志中 `[voice] 接线完成 / 接线已清理` 交替出现（React StrictMode 双调用 + HMR 重挂载），
无报错、无重复播放（挂载/清理配对正确）。

### 3.4 与后端对齐核对（只读，未改 backend/）

- `backend/interfaces/ws/protocol.py`：`pack_audio_frame`（4 字节大端头长 + UTF-8 JSON 头 + 音频）、
  `make_audio_header`（type/message_id/seq/format/sample_rate/final）——与前端逐字段一致。
- `backend/application/voice.py`：每句合成完发一帧、`final` 标记最后一帧——与前端队列模型匹配
  （前端按 seq 排序播放，不依赖 final）。
- `backend/interfaces/ws/dispatcher.py:141`：`on_interrupt` 取消 LLM 流、清 TTS 队列、回
  `reply_end{interrupted}`——前端打断闭环完整（气泡届时标记"（已打断）"）。

## 4. 需用户确认清单

1. **真声音**（无法在本环境听）：按 V 触发合成测试音应能听到 1.6s "说话感"音高起伏；
   真实对话时 TTS 语音是否清晰、音量是否合适。
2. **口型观感**：gain=4.5 / attack τ=35ms / release τ=140ms；实测包络 level 常顶到 1.0（张满），
   可能偏夸张——张嘴幅度/灵敏度需要看实机观感再调（`lipsync.ts` 顶部常量一处可调）。
3. **打断体验**：① 点击「停止」为**本地立即静音**（不等后端回声；后端 `reply_end{interrupted}` 到达
   会再清一次，幂等）——若希望严格等后端确认再停，可改为只发 interrupt；② 打断后气泡显示"（已打断）"
   由后端链路决定，需要真实对话验证一次。
4. **「停止」按钮显示时机**：除"说话/思考中"外我加了本地兜底（本地语音在播 / 回复流式中），
   避免后端 state 事件滞后时按钮不出现——是否可接受这种"多显示一点"的策略。
5. **队列跨消息策略**：不同 message_id 的帧按 FIFO 排队（不抢占）；正常时序下同一时刻只有一轮在播，
   该策略只是防御。若后端未来允许并发两轮 TTS，需要再讨论抢占规则。
6. **调试测试音的音色**（合成正弦音节）仅用于自测，不代表真实 TTS 效果。

## 5. 坑与遗留

- **TS 5.7 Float32Array 泛型**：`getFloatTimeDomainData` 要求 `Float32Array<ArrayBuffer>`（非
  ArrayBufferLike），已显式标注。
- **口型逐帧调用会刷日志**：已在渲染器 `setMouth` 做节流（变化>0.12 或 500ms），调试键 M 不受影响。
- **`Envelope | null`**：`WsClient.on` 的 envelope 参数类型变更（二进制帧无信封）；现有订阅者均未用
  该参数，编译期零破坏。
- **播放失败路径**：`play()` reject 与 `error` 事件双保险 + `finished` 防重入；已用 mock 验证"被拒后
  继续下一帧"。**真实"无音频设备"未实测**（本机有音频栈）。
- **AudioContext autoplay**：Electron 默认 `no-user-gesture-required`，另在 attach 时对
  `suspended` 做 `resume()` 防御；若 resume 失败仅记日志，播放不中断。
- **`reply_end`（非 interrupted）不清队列**：剩余已合成帧会播完（设计意图：最后一帧可能还在途）。
  如需"reply_end 即停"可加开关，未做。
- **HMR/StrictMode 安全**：`setupVoice` 返回 cleanup，App effect 生命周期管理；跨模块单例
  （wsClient/controller）不因 HMR 泄漏播放器。
- **调试入口**：V 键与 `window.__petVoiceDebug`（`playTone/stop/isSpeaking`）均为 dev-only；
  上线前无需清理（`import.meta.env.DEV` 自动剔除行为分支）。
- **验证工具位置**：`/tmp/voice-verify/`（run.ts 测试脚本、run.mjs 打包产物、backend-frame.bin
  后端真实帧、shot-playing.png 截图）——均为临时文件，不进版本控制；如需复跑见 §3.2/§3.3 命令。
- 未做（明确超出本次范围）：真实 mp3 帧的端到端播放（解析链路已用后端真实帧验证；播放链路用 WAV
  调试帧验证，两者共用同一 `VoicePlayer` 代码路径，仅 Blob MIME 分支不同）；多角色语音（P2 后半）。
