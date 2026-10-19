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
  /**
   * 连接角色（2026-10-18）：pet = 宠物窗（行为/提醒推送接收方）；
   * settings = 设置窗（只收发配置）。缺省按 pet 兼容旧客户端。
   */
  client_role?: ClientRole
}

/** 连接角色（与后端 protocol.py HelloData.client_role 对齐） */
export type ClientRole = 'pet' | 'settings'

/**
 * 附件引用（文件分析 P1）：用户在本机显式选择的文件。
 * 只传路径 + 显示名，不传正文（正文由本地后端读取、限额、注入本轮）。
 */
export interface AttachmentRef {
  path: string
  name?: string
}

/**
 * 单轮对话选项（工作模式，2026-10-18）。
 * 缺省 = 旧行为（允许联网）。
 */
export interface UserMessageOptions {
  /** 本轮是否向模型提供联网工具（false = 移除 web_search / web_fetch） */
  search?: boolean
  /** 教学模式：后端追加"老师口吻、分章节讲解"的临时提示（不落库、不进历史） */
  teaching?: boolean
}

/** 用户文字输入（可携带本轮附件与单轮选项） */
export interface UserMessageData {
  text: string
  session_id?: string | null
  attachments?: AttachmentRef[]
  options?: UserMessageOptions | null
  /** 前端本地消息 id：后端 message_saved 原样回传，用于把 DB 行 id 挂回同一条消息 */
  client_id?: string | null
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

/** 启动称呼引导（2026-10-18）：拉取用户画像摘要（无字段） */
export interface GetProfileData {}

/** 用户画像摘要：只含称呼类信息（是否有名字 + 名字 + 记忆提取开关） */
export interface ProfileData {
  has_name: boolean
  name?: string | null
  /** 后台记忆提取开关：false 时名字不会被自动写入画像，前端跳过称呼引导 */
  memory_enabled?: boolean
}

/** 前端本地展示的助手台词补录（启动称呼提问）：只写入会话历史，不触发回复 */
export interface NoteAssistantMessageData {
  text: string
}

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

/** 拉取历史消息（气泡回填）；session_id 缺省 = 当前连接会话 */
export interface LoadHistoryData {
  session_id?: string
  limit?: number
}

/** 删除单条消息（工作模式）：当前会话的 messages 表行 id */
export interface DeleteMessageData {
  id: number
}

/** 行为执行完成/被中断回报（Phase 3） */
export interface BehaviorDoneData {
  id: string
  interrupted: boolean
}

/** 拉取未读提醒（提醒列表，2026-10-18） */
export interface GetRemindersData {
  limit?: number
}

/** 提醒已读回执：按事件 id 或全部（2026-10-18） */
export interface AckRemindersData {
  ids?: string[]
  all?: boolean
}

/** 拉取时钟视图（当天事件 + 所有未到期计划；缺省今天） */
export interface GetReminderHistoryData {
  date?: string | null
  limit?: number
}

/** 删除时钟视图里的一项（id 为事件 id 或未到期计划 id） */
export interface DeleteReminderItemData {
  id: string
}

/** 提醒事件单项（proactive.items / reminders.items 共用，与 protocol.py ReminderItemData 对齐） */
export interface ReminderItemData {
  /** reminder_events 事件 id（"知道了"按它回执） */
  id: string
  reminder_id: string
  text: string
  due_at: string
  fired_at: string
  late: boolean
  /** 是否已读（今日视图里绿点/红点） */
  acknowledged: boolean
  /** 尚未到期（时钟入口视图；灰灯，不可点已读；id 此时是 reminders.id） */
  pending?: boolean
  /** 后端格式化好的用户可读时间（今天 09:00 / 10月18日 09:00） */
  time_text: string
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

// ---------------------------------------------------------------- 记忆本（2026-10-18）

/** 记忆本条目类型（program：设置页手动登记的可执行程序，2026-10-19） */
export type MemoryBookKind = 'link' | 'path' | 'text' | 'program'

/** 记忆本条目（设置页列表；与后端 MemoryBookItemData 对齐） */
export interface MemoryBookItemData {
  id: number
  name: string
  kind: MemoryBookKind
  value: string
  /** kind=path 时区分文件夹/文件 */
  is_dir: boolean
  created_at: number
  updated_at: number
  /** path/program 条目当前是否可用（path=存在；program=存在且可执行；失效标 ⚠） */
  path_exists: boolean
}

/** 记忆本列表快照（memory_book_list 的响应；保存成功后服务端也会主动刷新） */
export interface MemoryBookItemsData {
  items: MemoryBookItemData[]
  count: number
}

/** 记忆本写操作结果（保存/改名/删除记录/真实文件已删） */
export interface MemoryBookResultData {
  ok: boolean
  code: string
  message: string
}

/** 设置页：拉取记忆本 */
export interface MemoryBookListData {
  kind?: MemoryBookKind | null
}

/** 设置页：保存一条（与工具 save_item 的单条同构；name 可省略自动起名） */
export interface MemoryBookItemInput {
  name?: string
  kind?: MemoryBookKind | null
  value: string
}

/** 设置页：批量保存/同名更新 */
export interface MemoryBookSaveData {
  items: MemoryBookItemInput[]
}

/** 设置页：改名 */
export interface MemoryBookRenameData {
  old_name: string
  new_name: string
}

/** 设置页：删除**记录**（不动磁盘文件） */
export interface MemoryBookDeleteData {
  names: string[]
}

/** 宠物面：主进程已确认删除真实文件（移入回收站）——后端移除记录/清记忆 */
export interface MemoryBookFileDeletedData {
  path: string
}

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

/**
 * 一条消息已落库（工作模式，2026-10-18）。
 * - 用户消息：client_id = user_message.client_id（前端本地 id）；
 * - 助手消息：client_id = reply 的 message_id。
 */
export interface MessageSavedData {
  client_id: string
  db_id: number
  role: string
}

/** 单条消息删除结果（工作模式）；ok=false = 不属于当前会话/已不存在 */
export interface MessageDeletedData {
  id: number
  ok: boolean
}

/** 联网搜索来源（工作窗引用悬浮卡片） */
export interface SourceItemData {
  index: number
  title: string
  url: string
  snippet: string
  site_name: string
  date: string
}

/** 一轮回复用到的搜索来源（与正文分离） */
export interface SourcesData {
  message_id: string
  items: SourceItemData[]
}

/**
 * 推理模型思考过程增量（工作模式折叠展示）。
 * 只有网关返回 `delta.reasoning_content` 时才有；不进入正文/TTS。
 */
export interface ReasoningData {
  message_id: string
  text: string
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

/**
 * 工具调用（服务端 → 客户端执行，§4.7 工具机制）：
 * 模型本轮请求调用的内置工具（如 open_settings → 前端打开设置窗），在对应回复的
 * reply_end 之后推送；id 为本次调用的唯一标识（将来"结果回传续写"按 id 配对，
 * 当前前端仅按 name 执行、无需回执）。
 */
export interface ToolCallData {
  id: string
  name: string
  args: Record<string, unknown>
}

/**
 * 主动消息（问候/提醒），无对应用户输入。
 * 提醒（2026-10-18）：kind='reminder' 时带 reminder_id / due_at / late；
 * 前端**无论语音开关如何都要展示气泡**，语音只是后端追加的音频帧。
 */
export interface ProactiveData {
  message_id: string
  text: string
  emotion: string
  kind?: 'greeting' | 'reminder'
  /** 同一 tick 的提醒批次 id（气泡 meta 用它关联已读回执） */
  batch_id?: string | null
  /** 本批提醒逐项（单条时长度 1；气泡"知道了"按各项 id 回执） */
  items?: ReminderItemData[]
  /** 兼容单条旧字段：items 的第一项 */
  reminder_id?: string | null
  due_at?: string | null
  late?: boolean
}

/** 未读提醒快照（get_reminders / ack_reminders 的响应） */
export interface RemindersData {
  items: ReminderItemData[]
  unread_count: number
  /** 尚未到期的计划（灰灯；底部灰灯展开用） */
  pending?: ReminderItemData[]
  /** 尚未到期的提醒数（未读列表底部入口/角标用） */
  pending_count?: number
}

/** 时钟入口视图：当天全部事件（已读 + 未读）+ 所有未到期计划，按到期时间正序 */
export interface ReminderHistoryData {
  date: string
  items: ReminderItemData[]
  read_count: number
  unread_count: number
  /** 未到期计划数（items 中 pending=true 的条数） */
  pending_count?: number
}

/**
 * 一次性提示（文件分析 P1）：不进历史、不参与 TTS。
 * 例：context_reset = 为装下当前文件，本轮已丢弃旧上下文（界面历史仍在）。
 */
export interface NoticeData {
  code: string
  message: string
  level?: 'info' | 'warn' | 'error'
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
  /** 消息落库回执（工作模式：把 DB id 挂回消息，删除用） */
  message_saved: MessageSavedData
  /** 单条消息删除结果 */
  message_deleted: MessageDeletedData
  /** 本轮联网搜索来源（引用悬浮卡片） */
  sources: SourcesData
  /** 推理模型思考增量（工作模式「已思考」折叠块） */
  reasoning: ReasoningData
  token: TokenData
  sentence: SentenceData
  emotion: EmotionData
  /** 二进制音频帧（§3.5）：载荷为 {header, payload}（WsClient 二进制派发），信封模型仅为占位 */
  audio: AudioFramePacket
  reply_end: ReplyEndData
  /** 工具调用（§4.7 工具机制）：reply_end 之后推送，前端按 name 执行（如 open_settings 开设置窗） */
  tool_call: ToolCallData
  proactive: ProactiveData
  /** 未读提醒快照（get_reminders / ack_reminders 的响应） */
  reminders: RemindersData
  /** 某一天的全部提醒事件（今日视图） */
  reminder_history: ReminderHistoryData
  /** 记忆本列表快照（memory_book_list 响应 / 保存成功后的主动刷新） */
  memory_book_items: MemoryBookItemsData
  /** 记忆本写操作结果 */
  memory_book_result: MemoryBookResultData
  /** 一次性提示（文件分析丢历史等）；前端顶部/输入框上方轻提示 */
  notice: NoticeData
  history: HistoryData
  config: ConfigData
  /** 用户画像摘要（get_profile 的响应；启动称呼引导） */
  profile: ProfileData
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
  /** 启动称呼引导：拉取用户画像摘要 */
  get_profile: GetProfileData
  /** 前端本地展示的助手台词补录（只写入会话历史，不触发回复） */
  note_assistant_message: NoteAssistantMessageData
  load_history: LoadHistoryData
  /** 工作模式：删除当前会话的一条消息 */
  delete_message: DeleteMessageData
  behavior_done: BehaviorDoneData
  env_update: EnvUpdateData
  get_reminders: GetRemindersData
  ack_reminders: AckRemindersData
  get_reminder_history: GetReminderHistoryData
  delete_reminder_item: DeleteReminderItemData
  memory_book_list: MemoryBookListData
  memory_book_save: MemoryBookSaveData
  memory_book_rename: MemoryBookRenameData
  memory_book_delete: MemoryBookDeleteData
  memory_book_file_deleted: MemoryBookFileDeletedData
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
