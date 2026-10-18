/**
 * 工作窗消息状态（2026-10-18）。
 *
 * 纯 reducer：把「后端历史 + 宠物窗镜像事件」折叠成可渲染的消息列表。
 * 不直接调用 IPC/React，便于单测与后续复用到其它聊天界面。
 */
import type {
  WorkHistoryMessage,
  WorkMirrorEvent,
  WorkSourceItem
} from '../../electron/ipc/channels'

export interface WorkMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
  /** 推理模型的思考过程（仅实时流；历史不回填） */
  reasoning: string
  status: 'streaming' | 'done' | 'error'
  /** 本轮用户消息发送时间（思考用时 = 首个正文 token - sentAt） */
  sentAt: number
  /** 消息时间的权威值（列表常显；用户=发送时间，助手=开始回复/历史落库时间） */
  createdAt: number
  /** 后端 messages 表行 id（历史消息直接有；实时消息等 message_saved 回执） */
  dbId?: number
  /** 思考用时（ms）；只在有 reasoning 时定稿 */
  thinkingMs?: number
  interrupted?: boolean
  /** 本轮联网搜索的结构化来源（悬浮卡片；历史回填没有） */
  sources?: WorkSourceItem[]
}

export interface WorkNotice {
  kind: 'info' | 'warn' | 'error'
  text: string
}

export interface WorkState {
  messages: WorkMessage[]
  /** 最近一条用户消息时间（助手消息创建时继承） */
  lastUserAt: number
  /** 正在流式的助手消息 id */
  streamingId: string | null
  notice: WorkNotice | null
}

export const EMPTY_WORK_STATE: WorkState = {
  messages: [],
  lastUserAt: 0,
  streamingId: null,
  notice: null
}

export type WorkAction =
  | { type: 'reset' }
  | {
      type: 'history'
      messages: WorkHistoryMessage[]
      bufferedEvents: WorkMirrorEvent[]
      live?: { messageId: string; text: string; reasoning: string; startedAt: number }
    }
  | { type: 'mirror'; event: WorkMirrorEvent }
  | { type: 'clear-notice' }

function now(): number {
  return Date.now()
}

function historyId(item: WorkHistoryMessage): string {
  return `h_${String(item.id)}`
}

function historyDbId(item: WorkHistoryMessage): number | undefined {
  const value = typeof item.id === 'number' ? item.id : Number(item.id)
  return Number.isFinite(value) ? value : undefined
}

function fromHistory(item: WorkHistoryMessage): WorkMessage {
  const createdAt = item.created_at ?? now()
  return {
    id: historyId(item),
    role: item.role === 'user' ? 'user' : 'assistant',
    text: item.content ?? '',
    reasoning: '',
    status: 'done',
    sentAt: createdAt,
    createdAt,
    dbId: historyDbId(item)
  }
}

function findAssistant(state: WorkState, messageId: string): WorkMessage | undefined {
  return state.messages.find((item) => item.id === messageId)
}

/** 确保助手消息存在（reply_start 可能因中途打开而缺失） */
function ensureAssistant(state: WorkState, messageId: string): WorkState {
  if (findAssistant(state, messageId) !== undefined) return state
  return {
    ...state,
    messages: [
      ...state.messages,
      {
        id: messageId,
        role: 'assistant',
        text: '',
        reasoning: '',
        status: 'streaming',
        sentAt: state.lastUserAt,
        createdAt: now()
      }
    ],
    streamingId: messageId
  }
}

function patchAssistant(
  state: WorkState,
  messageId: string,
  patch: (message: WorkMessage) => WorkMessage
): WorkState {
  let found = false
  const messages = state.messages.map((item) => {
    if (item.id !== messageId) return item
    found = true
    return patch(item)
  })
  if (!found) {
    const base = ensureAssistant(state, messageId)
    return patchAssistant(base, messageId, patch)
  }
  return { ...state, messages }
}

function applyMirror(state: WorkState, event: WorkMirrorEvent): WorkState {
  switch (event.kind) {
    case 'user_message': {
      // 同一 localId 重复到达（重放/重试）只保留一条
      if (state.messages.some((item) => item.id === event.localId)) return state
      return {
        ...state,
        lastUserAt: event.sentAt,
        messages: [
          ...state.messages,
          {
            id: event.localId,
            role: 'user',
            text: event.text,
            reasoning: '',
            status: 'done',
            sentAt: event.sentAt,
            createdAt: event.sentAt
          }
        ]
      }
    }
    case 'message_saved': {
      if (!event.clientId) return state
      return {
        ...state,
        messages: state.messages.map((message) =>
          message.id === event.clientId ? { ...message, dbId: event.dbId } : message
        )
      }
    }
    case 'sources': {
      const base = ensureAssistant(state, event.messageId)
      return patchAssistant(base, event.messageId, (message) => ({
        ...message,
        sources: event.items
      }))
    }
    case 'message_deleted': {
      const messages = state.messages.filter((message) => message.dbId !== event.dbId)
      const deletedStreaming = state.messages.some(
        (message) => message.dbId === event.dbId && message.id === state.streamingId
      )
      const notice =
        event.ok === false
          ? { kind: 'warn' as const, text: '这条消息没删成（可能已不存在）～' }
          : state.notice
      return {
        ...state,
        messages,
        notice,
        streamingId: deletedStreaming ? null : state.streamingId
      }
    }
    case 'reply_start': {
      return ensureAssistant(state, event.messageId)
    }
    case 'reasoning': {
      const base = ensureAssistant(state, event.messageId)
      return patchAssistant(base, event.messageId, (message) => ({
        ...message,
        reasoning: message.reasoning + event.text
      }))
    }
    case 'token': {
      const base = ensureAssistant(state, event.messageId)
      return patchAssistant(base, event.messageId, (message) => ({
        ...message,
        text: message.text + event.text,
        thinkingMs:
          message.thinkingMs ??
          (message.reasoning.length > 0
            ? Math.max(0, now() - message.sentAt)
            : undefined)
      }))
    }
    case 'reply_end': {
      const base = ensureAssistant(state, event.messageId)
      const patched = patchAssistant(base, event.messageId, (message) => ({
        ...message,
        text: event.fullText || message.text,
        status: 'done',
        interrupted: event.interrupted,
        thinkingMs:
          message.thinkingMs ??
          (message.reasoning.length > 0
            ? Math.max(0, now() - message.sentAt)
            : undefined)
      }))
      return {
        ...patched,
        streamingId:
          patched.streamingId === event.messageId ? null : patched.streamingId
      }
    }
    case 'notice': {
      return {
        ...state,
        notice: {
          kind:
            event.level === 'error' ? 'error' : event.level === 'warn' ? 'warn' : 'info',
          text: event.message
        }
      }
    }
    case 'state':
    case 'emotion':
      return state
    default:
      return state
  }
}

export function workReducer(state: WorkState, action: WorkAction): WorkState {
  switch (action.type) {
    case 'reset':
      return EMPTY_WORK_STATE
    case 'clear-notice':
      return { ...state, notice: null }
    case 'mirror':
      return applyMirror(state, action.event)
    case 'history': {
      let next: WorkState = {
        ...EMPTY_WORK_STATE,
        messages: action.messages.map(fromHistory)
      }
      for (const event of action.bufferedEvents) {
        next = applyMirror(next, event)
      }
      if (action.live !== undefined && action.live !== null) {
        next = ensureAssistant(next, action.live.messageId)
        next = patchAssistant(next, action.live.messageId, (message) => ({
          ...message,
          text: action.live?.text || message.text,
          reasoning: action.live?.reasoning || message.reasoning,
          sentAt: action.live?.startedAt || message.sentAt,
          createdAt: action.live?.startedAt || message.createdAt
        }))
      }
      return next
    }
    default:
      return state
  }
}

/** 工作窗消息里可作导航锚点的用户提问（按出现顺序） */
export function navigatorMessages(messages: readonly WorkMessage[]): WorkMessage[] {
  return messages.filter((item) => item.role === 'user')
}
