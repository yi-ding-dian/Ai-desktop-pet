/**
 * 工作模式宠物面接线（2026-10-18）。
 *
 * 职责：
 * - 订阅主进程的工作窗发送/历史/打断请求，转进统一发送入口（sendUserMessage）；
 * - 把 WS 对话事件镜像给主进程（主进程再转给工作窗）；
 * - token/reasoning 按 25ms 合批（不用 rAF：窗口隐藏/遮挡时 rAF 会暂停）；
 * - 历史回填采用「单飞 + 序列边界」：请求后的事件先缓冲，和 history 响应一起
 *   原子交回工作窗，避免“历史一条 + 镜像又一条”的重复。
 *
 * 工作窗不存在时完全不镜像；宠物窗重载后由主进程重新下发 presence。
 */
import { getPetBridge } from '../../shared/pet-bridge'
import type { WsClient } from '../../shared/ws-client'
import type { UserMessageOptions } from '../../shared/protocol'
import type {
  WorkHistoryPayload,
  WorkHistoryRequestPayload,
  WorkMirrorEvent,
  WorkSendRequestPayload
} from '../../../electron/ipc/channels'
import { sendUserMessage, subscribeSentUserMessages } from '../teaching'
import { notifyUserMessage } from '../chat/name-onboarding'
import { interruptPetBehavior } from '../pet/behavior'
import { stopVoiceNow } from '../voice'
import { setWorkActiveLocal } from './state'

/** 合批窗口（ms）：token/reasoning 高频事件按此合并后走一次 IPC */
const FLUSH_MS = 25

interface StreamSnapshot {
  text: string
  reasoning: string
  startedAt: number
}

export function setupWorkPetSide(client: WsClient): () => void {
  const bridge = getPetBridge()

  /** 工作窗是否存在（主进程 presence 驱动；不是“是否可见”） */
  let workOpen = false
  /** 工作窗是否正在使用（可见且未最小化）——自主行为抑制 */
  let workActiveLocal = false
  let lastUserSentAt = 0
  let flushTimer: number | null = null
  let pending: WorkMirrorEvent[] = []
  let historyPending: WorkHistoryRequestPayload | null = null
  let historyBuffer: WorkMirrorEvent[] = []
  const currentStream = new Map<string, StreamSnapshot>()

  const flush = (): void => {
    if (flushTimer !== null) {
      window.clearTimeout(flushTimer)
      flushTimer = null
    }
    if (pending.length === 0) return
    const events = pending
    pending = []
    // 合并相邻同类增量，减少 IPC 条数（顺序不变）
    const merged: WorkMirrorEvent[] = []
    for (const event of events) {
      const last = merged[merged.length - 1]
      if (
        last !== undefined &&
        last.kind === event.kind &&
        event.kind === 'token' &&
        last.kind === 'token' &&
        last.messageId === event.messageId
      ) {
        merged[merged.length - 1] = { ...last, text: last.text + event.text }
      } else if (
        last !== undefined &&
        last.kind === 'reasoning' &&
        event.kind === 'reasoning' &&
        last.messageId === event.messageId
      ) {
        merged[merged.length - 1] = { ...last, text: last.text + event.text }
      } else {
        merged.push(event)
      }
    }
    for (const event of merged) report(event)
  }

  const report = (event: WorkMirrorEvent): void => {
    if (!workOpen) return
    // 历史请求在途：事件进缓冲，和历史响应一起原子交回工作窗（不单独发送）
    if (historyPending !== null) {
      historyBuffer.push(event)
      return
    }
    bridge.work?.reportEvent?.(event)
  }

  /** 立即上报（先 flush，保证顺序） */
  const emitNow = (event: WorkMirrorEvent): void => {
    flush()
    report(event)
  }

  /** 可合批上报 */
  const emitLater = (event: WorkMirrorEvent): void => {
    pending.push(event)
    if (flushTimer === null) {
      flushTimer = window.setTimeout(flush, FLUSH_MS)
    }
  }

  /** 历史回执（ack 主进程的 invoke） */
  const replyHistory = (payload: WorkHistoryPayload): void => {
    bridge.work?.reportHistory?.(payload)
  }

  // ------------------------------------------------------------------ 主进程请求

  const offSendRequest = bridge.work?.onSendRequest?.((payload: WorkSendRequestPayload) => {
    const trimmed = payload.text.trim()
    const attachments = payload.attachments.map((item) => ({
      path: item.path,
      name: item.name
    }))
    if (!trimmed && attachments.length === 0) {
      bridge.work?.sendResult?.({ requestId: payload.requestId, ok: false, reason: 'empty' })
      return
    }
    const options: UserMessageOptions = {
      search: payload.options?.search !== false
    }
    const question = trimmed || '帮我看看这个文件'
    const ok = sendUserMessage(client, question, attachments, options)
    // 与宠物胶囊一致：记录"用户已发言"（启动称呼引导据此判断是否还问名字）
    if (ok) notifyUserMessage(question)
    bridge.work?.sendResult?.({
      requestId: payload.requestId,
      ok,
      reason: ok ? undefined : 'not-connected'
    })
  })

  const offHistoryRequest = bridge.work?.onHistoryRequest?.(
    (payload: WorkHistoryRequestPayload) => {
      // 单飞：已有历史请求在途时，直接回空（工作窗不会并发发第二次）
      if (historyPending !== null) {
        replyHistory({
          requestId: payload.requestId,
          ok: false,
          reason: 'busy',
          messages: [],
          bufferedEvents: []
        })
        return
      }
      historyPending = payload
      historyBuffer = []
      const sent = client.send('load_history', { limit: payload.limit ?? 200 })
      if (!sent) {
        historyPending = null
        historyBuffer = []
        replyHistory({
          requestId: payload.requestId,
          ok: false,
          reason: 'not-connected',
          messages: [],
          bufferedEvents: []
        })
      }
    }
  )

  const offInterrupt = bridge.work?.onInterrupt?.(() => {
    const sent = client.send('interrupt', {})
    stopVoiceNow('工作模式停止')
    if (import.meta.env.DEV) console.log(`[work] 打断已发（sent=${sent}）`)
  })

  const offDeleteMessage = bridge.work?.onDeleteMessage?.(({ dbId }) => {
    if (typeof dbId !== 'number' || !Number.isFinite(dbId) || dbId <= 0) return
    const sent = client.send('delete_message', { id: Math.trunc(dbId) })
    if (import.meta.env.DEV) console.log(`[work] 删除消息 id=${dbId}（sent=${sent}）`)
  })

  const offPresence = bridge.work?.onPresence?.(({ open, active }) => {
    const wasActive = workActiveLocal
    workOpen = Boolean(open)
    workActiveLocal = Boolean(active)
    setWorkActiveLocal(workActiveLocal)
    // 进入工作模式（窗口可见）：立刻打断正在进行的自主行为（走路/打盹等），
    // 否则引擎会让宠物在依附后继续走开
    if (workActiveLocal && !wasActive) {
      interruptPetBehavior('进入工作模式')
    }
    if (!workOpen) {
      pending = []
      historyPending = null
      historyBuffer = []
      currentStream.clear()
      if (flushTimer !== null) {
        window.clearTimeout(flushTimer)
        flushTimer = null
      }
    }
  })

  // ------------------------------------------------------------------ WS 镜像

  const offSent = subscribeSentUserMessages((text, localId) => {
    lastUserSentAt = Date.now()
    emitNow({
      kind: 'user_message',
      localId,
      text,
      sentAt: lastUserSentAt
    })
  })

  const offMessageSaved = client.on('message_saved', ({ client_id, db_id, role }) => {
    emitNow({ kind: 'message_saved', clientId: client_id, dbId: db_id, role })
  })

  const offMessageDeleted = client.on('message_deleted', ({ id, ok }) => {
    emitNow({ kind: 'message_deleted', dbId: id, ok })
  })

  const offSources = client.on('sources', ({ message_id, items }) => {
    emitNow({ kind: 'sources', messageId: message_id, items })
  })

  const offReplyStart = client.on('reply_start', ({ message_id }) => {
    currentStream.set(message_id, {
      text: '',
      reasoning: '',
      startedAt: lastUserSentAt || Date.now()
    })
    emitNow({ kind: 'reply_start', messageId: message_id })
  })

  const offReasoning = client.on('reasoning', ({ message_id, text }) => {
    const stream = currentStream.get(message_id)
    if (stream !== undefined) stream.reasoning += text
    else currentStream.set(message_id, { text: '', reasoning: text, startedAt: lastUserSentAt || Date.now() })
    emitLater({ kind: 'reasoning', messageId: message_id, text })
  })

  const offToken = client.on('token', ({ message_id, text }) => {
    const stream = currentStream.get(message_id)
    if (stream !== undefined) stream.text += text
    else currentStream.set(message_id, { text, reasoning: '', startedAt: lastUserSentAt || Date.now() })
    emitLater({ kind: 'token', messageId: message_id, text })
  })

  const offReplyEnd = client.on('reply_end', ({ message_id, full_text, interrupted }) => {
    flush()
    currentStream.delete(message_id)
    emitNow({
      kind: 'reply_end',
      messageId: message_id,
      fullText: full_text ?? '',
      interrupted: Boolean(interrupted)
    })
  })

  const offState = client.on('state', ({ state }) => {
    emitNow({ kind: 'state', state })
  })

  const offEmotion = client.on('emotion', ({ message_id, emotion, intensity }) => {
    // tap_head 的 emotion 没有 message_id：不是对话消息，不镜像
    if (!message_id) return
    emitNow({ kind: 'emotion', messageId: message_id, emotion, intensity })
  })

  const offNotice = client.on('notice', ({ code, message, level }) => {
    emitNow({ kind: 'notice', code, message, level })
  })

  // 对话/连接错误也镜像到工作窗：用户可能正看着工作窗，不能只让宠物气泡提示
  const offError = client.on('error', ({ code, message }) => {
    emitNow({ kind: 'notice', code, message, level: 'error' })
  })

  // 补一次当前存在性：宠物窗重载时可能错过主进程在 did-finish-load 时发来的 presence
  void bridge.work
    ?.getPresence?.()
    .then(({ open, active }) => {
      workOpen = Boolean(open)
      workActiveLocal = Boolean(active)
      setWorkActiveLocal(workActiveLocal)
      if (workActiveLocal) interruptPetBehavior('进入工作模式')
    })
    .catch(() => {
      /* 主进程未就绪：忽略，后续靠 presence 广播 */
    })

  // 历史响应：与缓冲事件一起原子回给工作窗
  const offHistory = client.on('history', (data) => {
    if (historyPending === null) return
    const requestId = historyPending.requestId
    historyPending = null
    const buffered = historyBuffer
    historyBuffer = []
    const messages = Array.isArray(data.messages)
      ? (data.messages as unknown as WorkHistoryPayload['messages'])
      : []
    let live: WorkHistoryPayload['live']
    for (const [messageId, stream] of currentStream) {
      live = {
        messageId,
        text: stream.text,
        reasoning: stream.reasoning,
        startedAt: stream.startedAt
      }
    }
    replyHistory({ requestId, ok: true, messages, bufferedEvents: buffered, live })
  })

  return () => {
    setWorkActiveLocal(false)
    flush()
    offSendRequest?.()
    offHistoryRequest?.()
    offInterrupt?.()
    offDeleteMessage?.()
    offPresence?.()
    offSent()
    offMessageSaved()
    offMessageDeleted()
    offSources()
    offReplyStart()
    offReasoning()
    offToken()
    offReplyEnd()
    offState()
    offEmotion()
    offNotice()
    offError()
    offHistory()
    if (flushTimer !== null) {
      window.clearTimeout(flushTimer)
      flushTimer = null
    }
  }
}
