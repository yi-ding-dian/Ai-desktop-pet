/**
 * WS 协议 v1 的 TypeScript 类型定义。
 *
 * 单一事实来源：后端 `backend/interfaces/ws/protocol.py`（逐字段手工对齐）与设计文档 §3。
 * TODO(设计文档 §10 待办 #7)：应改为从 Pydantic 模型自动生成 TS 类型，消除手工对齐的漂移风险。
 *
 * 说明：`audio_chunk` / `audio` 为 Phase 2 二进制帧（§3.5），文本帧侧仅占位模型。
 */

export const PROTOCOL_VERSION = 1

// ---------------------------------------------------------------- §3.1 信封

/** 消息信封（与 protocol.py Envelope 对齐；data 由各事件类型收窄） */
export interface Envelope<T = unknown> {
  v: number
  id: string
  reply_to: string | null
  type: string
  ts: number
  data: T
}

// ---------------------------------------------------------------- §3.2 客户端 → 服务端

/** 连接后首条消息：鉴权 + 版本协商 */
export interface HelloData {
  token: string
  protocol_version: number
  app_version: string
}

/** 用户文字输入 */
export interface UserMessageData {
  text: string
  session_id?: string | null
}

/** 心跳（§3.6：前端每 30s 发 ping，服务端回 pong） */
export interface PingData {}

/** 打断：取消当前流式回复 */
export interface InterruptData {}

/** 宠物交互事件（tap_head / drag_end / idle_touch） */
export interface PetEventData {
  kind: string
  payload: Record<string, unknown>
}

/** 拉取当前配置 */
export interface GetConfigData {}

/** 更新配置（含设置 LLM key 的专用字段） */
export interface SetConfigData {
  patch: Record<string, unknown>
}

/** 设置面板「测试连接」 */
export interface TestLlmData {
  base_url: string
  model: string
  key?: string | null
}

/** 拉取历史消息（气泡回填） */
export interface LoadHistoryData {
  session_id: string
  limit: number
}

/** 行为执行完成/被中断回报（Phase 3） */
export interface BehaviorDoneData {
  id: string
  interrupted: boolean
}

/** 屏幕坐标点（与 electron/window Point 结构一致；协议层独立定义避免依赖 electron 目录） */
export interface EnvPoint {
  x: number
  y: number
}

/** 窗口尺寸 */
export interface EnvSize {
  width: number
  height: number
}

/** 工作区矩形（屏幕坐标 + 尺寸） */
export interface EnvRect {
  x: number
  y: number
  width: number
  height: number
}

/** 环境上报：屏幕/窗口几何 + 系统空闲 + 宠物状态（行为决策依据，§4.5.5） */
export interface EnvUpdateData {
  work_area?: EnvRect | null
  window_pos?: EnvPoint | null
  window_size?: EnvSize | null
  /** 系统空闲秒数（主进程 powerMonitor.getSystemIdleTime）——"用户是否在用电脑" */
  system_idle_seconds?: number | null
  /** 渲染侧当前宠物状态——对话中引擎静默的旁路信号（引擎不读 chat_pipeline） */
  pet_state?: PetState | null
}

/** Phase 2：音频输入走二进制帧（§3.5），文本帧侧仅占位 */
export interface AudioChunkData {}

// ---------------------------------------------------------------- §3.3 服务端 → 客户端

/** 鉴权结果；ok=false 时伴随 error 后断开 */
export interface HelloAckData {
  ok: boolean
  session_id: string | null
  server_version: string
  protocol_version: number
}

/** 宠物状态机取值（与 protocol.py StateData 的 Literal 对齐） */
export type PetState = 'idle' | 'walking' | 'sleeping' | 'thinking' | 'speaking' | 'dragging'

/** 宠物状态机（驱动动画节奏与行为互斥） */
export interface StateData {
  state: PetState
}

/** 行为指令（Phase 3） */
export interface BehaviorData {
  id: string
  name: string
  params: Record<string, unknown>
}

/** 一轮回复开始 */
export interface ReplyStartData {
  message_id: string
}

/** 流式增量文本 */
export interface TokenData {
  message_id: string
  text: string
}

/** 分句完成（供 TTS 流水线，Phase 2 推送） */
export interface SentenceData {
  message_id: string
  index: number
  text: string
}

/** v1 固定情绪集合（§3.3 约定；后端白名单外的标签会被剥离，不会推到前端） */
export const EMOTION_VALUES = [
  'neutral',
  'happy',
  'sad',
  'angry',
  'surprised',
  'shy',
  'thinking',
  'sleepy'
] as const

export type Emotion = (typeof EMOTION_VALUES)[number]

/** 情绪切换（前端表情/动作映射） */
export interface EmotionData {
  message_id: string
  emotion: string
  intensity: number
}

/** 一轮回复结束 */
export interface ReplyEndData {
  message_id: string
  full_text: string
  interrupted?: boolean | null
}

/** 主动消息（问候/提醒），无对应用户输入 */
export interface ProactiveData {
  message_id: string
  text: string
  emotion: string
}

/** 历史回填 */
export interface HistoryData {
  session_id: string
  messages: Array<Record<string, unknown>>
}

/** 配置快照（Pydantic 侧 extra=allow，字段自由） */
export type ConfigData = Record<string, unknown>

/**
 * 「测试连接」结果（§3.3，P4 设置面板 test_llm 的响应）：
 * ok=false 时 message 为具体原因（连不上/401 Key 错/404 地址错…）；
 * 成功且网关支持 `/v1/models` 时附模型列表（供设置页模型下拉）。
 */
export interface LlmTestResultData {
  ok: boolean
  message: string
  models?: string[] | null
}

/** 错误；fatal=true 表示连接将关闭 */
export interface ErrorData {
  code: string
  message: string
  fatal?: boolean | null
}

/** 心跳应答 */
export interface PongData {}

// ---------------------------------------------------------------- §3.5 二进制音频帧
// 音频不走 JSON 文本帧：一句话一帧，线上格式 [4字节大端 JSON头长度 N][JSON头 N字节][音频数据]。
// 解析实现见 shared/ws-client/binary-frame.ts（parseAudioFrame）。

/**
 * 二进制音频帧的 JSON 头（§3.5）。
 * 与后端 interfaces/ws/protocol.py 的 `pack_audio_frame` / `make_audio_header` 逐字段对齐
 * （2026-10-14 已核对：4 字节大端头长；字段 type/message_id/seq/format/sample_rate/final）。
 */
export interface AudioFrameHeader {
  /** 固定 'audio'（frontend 解析时校验） */
  type: 'audio'
  /** 该帧所属回复的 message_id（前端按它分组、与 reply_* 事件配对） */
  message_id: string
  /** 同一消息内的帧序号（从 0 递增；前端组内按 seq 升序播放） */
  seq: number
  /** 音频编码：'mp3'（Edge TTS 输出）；调试自测入口可能为 'wav' */
  format: string
  /** 采样率（Hz），当前 24000 */
  sample_rate: number
  /** 是否该消息的最后一帧（前端清队列不依赖它，仅日志） */
  final: boolean
}

/**
 * 解析后的二进制音频帧：JSON 头 + 音频体。
 * 注：`audio` 事件由二进制帧承载（非信封文本帧），WsClient 派发时 envelope 为 null。
 */
export interface AudioFramePacket {
  header: AudioFrameHeader
  /** 未解码的音频体（独立 ArrayBuffer；Blob 构造时浏览器会再复制一次，属预期） */
  payload: ArrayBuffer
}

// ---------------------------------------------------------------- 事件注册表（type → 载荷）

/** 服务端事件映射（与 protocol.py SERVER_EVENT_MODELS 对齐） */
export interface ServerEventMap {
  hello_ack: HelloAckData
  state: StateData
  behavior: BehaviorData
  reply_start: ReplyStartData
  token: TokenData
  sentence: SentenceData
  emotion: EmotionData
  /** 二进制音频帧（§3.5）：载荷为 {header, payload}（WsClient 二进制派发），信封模型仅为占位 */
  audio: AudioFramePacket
  reply_end: ReplyEndData
  proactive: ProactiveData
  history: HistoryData
  config: ConfigData
  llm_test_result: LlmTestResultData
  error: ErrorData
  pong: PongData
}

export type ServerEventType = keyof ServerEventMap

/** 客户端事件映射（与 protocol.py CLIENT_EVENT_MODELS 对齐） */
export interface ClientEventMap {
  hello: HelloData
  user_message: UserMessageData
  ping: PingData
  interrupt: InterruptData
  pet_event: PetEventData
  get_config: GetConfigData
  set_config: SetConfigData
  test_llm: TestLlmData
  load_history: LoadHistoryData
  behavior_done: BehaviorDoneData
  env_update: EnvUpdateData
  audio_chunk: AudioChunkData
}

export type ClientEventType = keyof ClientEventMap

/** 生成客户端消息 id（协议要求发送方生成；crypto 不可用时退化为随机串） */
export function makeMessageId(): string {
  const uuid = globalThis.crypto?.randomUUID?.()
  return uuid ? `c_${uuid}` : `c_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`
}

/** 构造客户端信封对象 */
export function makeEnvelope<T extends ClientEventType>(
  type: T,
  data: ClientEventMap[T],
  replyTo: string | null = null
): Envelope<ClientEventMap[T]> {
  return { v: PROTOCOL_VERSION, id: makeMessageId(), reply_to: replyTo, type, ts: Date.now(), data }
}

/** 序列化为单行 JSON 文本帧（与后端 serialize_envelope 对应） */
export function serializeEnvelope<T extends ClientEventType>(
  type: T,
  data: ClientEventMap[T],
  replyTo: string | null = null
): string {
  return JSON.stringify(makeEnvelope(type, data, replyTo))
}
