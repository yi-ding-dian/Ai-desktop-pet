/**
 * 教学域（P5 §7.5）：宠物面接线。宠物窗口侧的教学模式职责全部收拢在本文件。
 *
 * 职责：
 * - onState 订阅分发：主进程教学状态（mode/folded/podium）→ 本地状态镜像 + 转发 UI 订阅者（App）；
 * - 统一发送入口 sendUserMessage()：聊天输入框（键盘路径）与黑板输入条（onSendRequest）共用——
 *   关键词（开始教学/下课）→ WS 发送 → 教学模式中镜像给黑板 + 推入头顶气泡；
 * - 镜像上报：教学模式中把 user_message / reply_start / token / reply_end 镜像给黑板（§7.5.2 镜像方案）；
 * - 问题气泡：每个用户提问在头顶堆叠（本地列表 + 订阅），点击 → goto 黑板跳段。
 *
 * 黑板是"哑显示"：对话主体仍走宠物窗口的 WS 连接，本域只做镜像与转发（语音/口型/情绪/打断零改动）。
 * 兼容性：所有 bridge teaching.* 调用一律可选链容错——旧 preload（A 侧尚未就绪）缺失时静默跳过。
 */
import { getPetBridge } from '../../shared/pet-bridge'
import type { WsClient } from '../../shared/ws-client'
import type {
  TeachingEnterReason,
  TeachingMirrorEvent,
  TeachingStatePayload
} from '../../../electron/ipc/channels'
import { isTeachingMode, setTeachingModeLocal } from './state'

export { default as TeachingBubbles } from './TeachingBubbles'

/** dev 态日志（转发到主进程日志，便于无 devtools 验证）；生产构建自动剔除 */
const devLog = (msg: string): void => {
  if (import.meta.env.DEV) console.log(`[teaching] ${msg}`)
}

/** 一条头顶问题气泡（课堂目录条目） */
export interface TeachingBubbleItem {
  /** 本地气泡 id：随 user_message 镜像一并上报，点击气泡 goto(localId) 由黑板据映射跳段 */
  localId: string
  text: string
}

/**
 * user_message 镜像（契约类型 + 运行时附加 localId）。
 *
 * 契约 TeachingMirrorEvent.user_message 只有 text；但头顶气泡点击要以 localId 找黑板段落，
 * 故运行时附带 localId——黑板侧读取即可建立"问题（localId）→ 讲解段落（reply 的 messageId）"
 * 映射；不读取亦无害（多余字段被忽略）。主进程路由时原样转发（结构化克隆保留附加字段）。
 */
type UserMessageMirrorEvent = Extract<TeachingMirrorEvent, { kind: 'user_message' }> & {
  localId: string
}

// ------------------------------------------------------------------ 本地状态（模块级单例）

/** 气泡列表（push 顺序：旧 → 新；退出教学模式时清空） */
let bubbles: TeachingBubbleItem[] = []

/** token 累积（messageId → 已收文本）：reply_end.fullText 为空时的兜底（独立于 ChatPanel 的累积） */
const tokenAccum = new Map<string, string>()

const stateSubscribers = new Set<(state: TeachingStatePayload) => void>()
const bubbleSubscribers = new Set<(items: TeachingBubbleItem[]) => void>()

/** 订阅教学模式状态（App：面板收起/气泡显隐/讲台走位）；返回取消订阅函数 */
export function subscribeTeachingState(cb: (state: TeachingStatePayload) => void): () => void {
  stateSubscribers.add(cb)
  return () => {
    stateSubscribers.delete(cb)
  }
}

/** 订阅头顶问题气泡列表（App 渲染 TeachingBubbles）；返回取消订阅函数 */
export function subscribeTeachingBubbles(cb: (items: TeachingBubbleItem[]) => void): () => void {
  bubbleSubscribers.add(cb)
  return () => {
    bubbleSubscribers.delete(cb)
  }
}

/** 生成气泡本地 id（crypto 不可用时退化为随机串，与 protocol.makeMessageId 同款兜底） */
function makeLocalId(): string {
  const uuid = globalThis.crypto?.randomUUID?.()
  return uuid ?? `t_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`
}

function emitState(state: TeachingStatePayload): void {
  for (const cb of [...stateSubscribers]) {
    try {
      cb(state)
    } catch (err) {
      console.error('[teaching] 状态订阅者抛错：', err)
    }
  }
}

function emitBubbles(): void {
  for (const cb of [...bubbleSubscribers]) {
    try {
      cb(bubbles)
    } catch (err) {
      console.error('[teaching] 气泡订阅者抛错：', err)
    }
  }
}

/** 推入一条问题气泡（返回 localId，供镜像上报使用） */
function pushBubble(text: string): string {
  const localId = makeLocalId()
  bubbles = [...bubbles, { localId, text }]
  emitBubbles()
  return localId
}

/** 清空气泡（退出教学模式时） */
function clearBubbles(): void {
  if (bubbles.length === 0) return
  bubbles = []
  emitBubbles()
}

// ------------------------------------------------------------------ bridge 工具（可选链容错）

/** 请求进入教学模式（"开始教学/教学模式"关键词；reason 供主进程日志） */
export function enterTeaching(reason: TeachingEnterReason): void {
  devLog(`请求进入教学模式（${reason}）`)
  getPetBridge().teaching?.enter?.(reason)
}

/** 请求退出教学模式（"结束教学/下课"关键词） */
export function exitTeaching(): void {
  devLog('请求退出教学模式')
  getPetBridge().teaching?.exit?.()
}

/** 点击头顶气泡 → 请求黑板跳转到该问题的讲解段落 */
export function gotoTeachingBubble(localId: string): void {
  devLog(`气泡点击 → goto(${localId})`)
  getPetBridge().teaching?.goto?.(localId)
}

/** 拖拽开始（App 的拖拽判定处调用；非教学模式主进程忽略）——教学模式中触发黑板折叠让路 */
export function notifyTeachingDragStart(): void {
  getPetBridge().teaching?.notifyDragStart?.()
}

/** 上报一条镜像对话事件（主进程路由给黑板；调用方负责仅在教学模式中调用） */
function reportMirror(event: TeachingMirrorEvent): void {
  getPetBridge().teaching?.reportMirror?.(event)
}

// ------------------------------------------------------------------ 统一发送入口

/** "下课"关键词（先判退出：'结束教学模式' 同时命中进入关键词，顺序不能反） */
const EXIT_KEYWORDS = /下课|结束教学/
/** "开课"关键词（显式触发，第一版不做 LLM 自动识别） */
const ENTER_KEYWORDS = /开始教学|教学模式/

/**
 * 统一发送入口（聊天输入框键盘路径 + 黑板输入条路径共用）。
 *
 * 顺序（制定要求）：关键词处理（enter/exit）→ WS 发送 → 教学模式中镜像 + 推入头顶气泡。
 * 返回 false 表示连接未就绪、未送出（调用方不应更新本地气泡）。
 *
 * 注："打开设置"类关键词动作已迁至后端（§4.7 工具机制：后端走快通道/模型 tools 协议推
 * `tool_call` 事件，前端 tools 域执行开窗）——本入口对这类消息只照常发往后端。
 */
export function sendUserMessage(client: WsClient, text: string): boolean {
  // ① 关键词：必须在发送/镜像之前——"开始教学"之后的消息才进入镜像链路
  if (EXIT_KEYWORDS.test(text)) {
    exitTeaching()
  } else if (ENTER_KEYWORDS.test(text)) {
    enterTeaching('keyword')
  }

  // ② 照常发往后端（消息本身不受教学模式影响）
  if (!client.send('user_message', { text })) return false

  // ③ 教学模式中：推入头顶气泡 + 镜像给黑板（localId 一并带上，黑板据此建立问题→段落映射）
  if (isTeachingMode()) {
    const localId = pushBubble(text)
    const event: UserMessageMirrorEvent = { kind: 'user_message', text, localId }
    reportMirror(event)
    devLog(`镜像 user_message（localId=${localId}）：${text.slice(0, 24)}`)
  }
  return true
}

// ------------------------------------------------------------------ 接线

/**
 * 宠物面接线（App 挂载时调用一次；返回清理函数）。
 * StrictMode 双调用安全：重复 setup 会替换旧订阅（各 off 均释放）。
 *
 * 注：新增 bridge API 需重启 Electron 主进程才可用；旧 preload 无 teaching 段时全部静默跳过。
 */
export function setupTeachingPetSide(client: WsClient): () => void {
  const bridge = getPetBridge()

  // ① 主进程状态广播 → 本地镜像 + 分发（App 侧做 UI/走位）；退出时清空气泡与镜像累积
  const handleState = (state: TeachingStatePayload): void => {
    devLog(`onState → mode=${state.mode} folded=${state.folded} reason=${state.reason ?? '-'}`)
    setTeachingModeLocal(state.mode === 'teaching')
    if (state.mode !== 'teaching') {
      clearBubbles()
      tokenAccum.clear()
    }
    emitState(state)
  }

  const offState = bridge.teaching?.onState?.(handleState)

  // ② 黑板输入条 → 宠物面执行发送（与聊天输入框走同一入口：关键词 + 发送 + 镜像 + 气泡）
  const offSend = bridge.teaching?.onSendRequest?.(({ text }) => {
    const trimmed = text.trim()
    if (!trimmed) return
    const sent = sendUserMessage(client, trimmed)
    devLog(`黑板输入条发送（sent=${sent}）：${trimmed.slice(0, 24)}`)
  })

  // ③ 对话镜像（仅教学模式中上报；token 无条件累积，供 reply_end.fullText 兜底）
  const offReplyStart = client.on('reply_start', ({ message_id }) => {
    tokenAccum.set(message_id, '')
    if (!isTeachingMode()) return
    reportMirror({ kind: 'reply_start', messageId: message_id })
  })
  const offToken = client.on('token', ({ message_id, text }) => {
    tokenAccum.set(message_id, (tokenAccum.get(message_id) ?? '') + text)
    if (!isTeachingMode()) return
    reportMirror({ kind: 'token', messageId: message_id, text })
  })
  const offReplyEnd = client.on('reply_end', ({ message_id, full_text, interrupted }) => {
    const accumulated = tokenAccum.get(message_id) ?? ''
    tokenAccum.delete(message_id)
    if (!isTeachingMode()) return
    // full_text 是后端权威终稿；为空（异常路径）时用 token 累积兜底
    reportMirror({
      kind: 'reply_end',
      messageId: message_id,
      fullText: full_text || accumulated,
      interrupted: Boolean(interrupted)
    })
  })

  // ④ 补齐初始状态（渲染侧晚于主进程广播订阅时；旧 preload 无 getState 时静默跳过）
  let disposed = false
  const initial = bridge.teaching?.getState?.()
  initial
    ?.then((state) => {
      if (!disposed) handleState(state)
    })
    .catch(() => {
      /* 主进程未就绪：忽略，后续靠 onState 广播 */
    })

  return () => {
    disposed = true
    offState?.()
    offSend?.()
    offReplyStart()
    offToken()
    offReplyEnd()
  }
}
