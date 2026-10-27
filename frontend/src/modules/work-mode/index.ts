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
  WorkConversationDeletedPayload,
  WorkConversationRenamedPayload,
  WorkConversationsPayload,
  WorkConversationsRequestPayload,
  WorkDeleteConversationRequestPayload,
  WorkHistoryPayload,
  WorkHistoryRequestPayload,
  WorkMirrorEvent,
  WorkRenameConversationRequestPayload,
  WorkSendRequestPayload
} from '../../../electron/ipc/channels'
import { sendUserMessage, subscribeSentUserMessages } from '../teaching'
import { notifyUserMessage } from '../chat/name-onboarding'
import { interruptPetBehavior } from '../pet/behavior'
import { stopVoiceNow } from '../voice'
import { setWorkActiveLocal } from './state'
import {
  isForegroundSession,
  setActiveConversationId
} from './active-conversation'

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
  /** 最近一次发送的目标对话（回复事件没有 session_id，靠它回填到对应会话） */
  let lastSentSessionId: string | undefined
  /** 消息 id → 对话 id（流式期间的消息归属） */
  const messageSessions = new Map<string, string>()
  /** 最近一次删除消息所属对话（message_deleted 事件没有 session_id） */
  let lastDeleteSessionId: string | undefined
  /** 对话列表请求（单飞） */
  let conversationsPending: string | null = null
  const renamePending = new Map<
    string,
    { id: string; resolve: (payload: WorkConversationRenamedPayload) => void }
  >()
  const deletePending = new Map<
    string,
    { id: string; resolve: (payload: WorkConversationDeletedPayload) => void }
  >()

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
    // 历史请求在途：只缓冲本次请求会话的事件；别的对话的流照常实时上报，
    // 否则它们会被塞进本次 history 的 bufferedEvents，串到错误的对话里。
    if (historyPending !== null) {
      const requested = historyPending.sessionId
      if (requested && event.sessionId && event.sessionId !== requested) {
        bridge.work?.reportEvent?.(event)
        return
      }
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
      name: item.name,
      ...(item.ref ? { ref: item.ref } : {})
    }))
    if (!trimmed && attachments.length === 0) {
      bridge.work?.sendResult?.({ requestId: payload.requestId, ok: false, reason: 'empty' })
      return
    }
    const options: UserMessageOptions = {
      search: payload.options?.search !== false
    }
    const question = trimmed || '帮我看看这个文件'
    if (payload.sessionId) setActiveConversationId(payload.sessionId)
    const ok = sendUserMessage(client, question, attachments, options, payload.sessionId)
    if (ok) lastSentSessionId = payload.sessionId
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
      const sent = client.send('load_history', {
        limit: payload.limit ?? 200,
        ...(payload.sessionId ? { session_id: payload.sessionId } : {})
      })
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

  const offConversationsRequest = bridge.work?.onConversationsRequest?.(
    (payload: WorkConversationsRequestPayload) => {
      if (conversationsPending !== null) {
        bridge.work?.reportConversations?.({
          requestId: payload.requestId,
          ok: false,
          reason: 'busy',
          items: []
        })
        return
      }
      const sent = client.send('list_conversations', {})
      if (!sent) {
        bridge.work?.reportConversations?.({
          requestId: payload.requestId,
          ok: false,
          reason: 'not-connected',
          items: []
        })
        return
      }
      conversationsPending = payload.requestId
    }
  )

  const offRenameConversationRequest = bridge.work?.onRenameConversationRequest?.(
    (payload: WorkRenameConversationRequestPayload) => {
      const sent = client.send('rename_conversation', {
        id: payload.id,
        title: payload.title
      })
      if (!sent) {
        bridge.work?.reportConversationRenamed?.({
          requestId: payload.requestId,
          id: payload.id,
          ok: false,
          reason: 'not-connected'
        })
        return
      }
      renamePending.set(payload.requestId, {
        id: payload.id,
        resolve: (result) => bridge.work?.reportConversationRenamed?.(result)
      })
    }
  )

  const offDeleteConversationRequest = bridge.work?.onDeleteConversationRequest?.(
    (payload: WorkDeleteConversationRequestPayload) => {
      const sent = client.send('delete_conversation', { id: payload.id })
      if (!sent) {
        bridge.work?.reportConversationDeleted?.({
          requestId: payload.requestId,
          id: payload.id,
          ok: false,
          reason: 'not-connected'
        })
        return
      }
      deletePending.set(payload.requestId, {
        id: payload.id,
        resolve: (result) => bridge.work?.reportConversationDeleted?.(result)
      })
    }
  )

  const offInterrupt = bridge.work?.onInterrupt?.((sessionId?: string) => {
    const sent = client.send('interrupt', {
      ...(sessionId ? { session_id: sessionId } : {})
    })
    if (isForegroundSession(sessionId)) stopVoiceNow('工作模式停止')
    if (import.meta.env.DEV) console.log(`[work] 打断已发（session=${sessionId ?? '前台'} sent=${sent}）`)
  })

  const offFocusConversation = bridge.work?.onFocusConversation?.((sessionId: string) => {
    setActiveConversationId(sessionId)
    client.send('conversation_focus', { session_id: sessionId })
    // 切换后旧对话的 TTS 不再继续占用前台声音
    stopVoiceNow('切换对话')
  })

  const offDeleteMessage = bridge.work?.onDeleteMessage?.(({ dbId, sessionId }) => {
    if (typeof dbId !== 'number' || !Number.isFinite(dbId) || dbId <= 0) return
    lastDeleteSessionId = sessionId
    const sent = client.send('delete_message', {
      id: Math.trunc(dbId),
      ...(sessionId ? { session_id: sessionId } : {})
    })
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

  const offSent = subscribeSentUserMessages((text, localId, sessionId) => {
    lastUserSentAt = Date.now()
    if (sessionId) lastSentSessionId = sessionId
    emitNow({
      kind: 'user_message',
      localId,
      text,
      sentAt: lastUserSentAt,
      sessionId
    })
  })

  const offMessageSaved = client.on('message_saved', ({ client_id, db_id, role, session_id }) => {
    emitNow({
      kind: 'message_saved',
      clientId: client_id,
      dbId: db_id,
      role,
      sessionId: session_id ?? lastSentSessionId
    })
  })

  const offMessageDeleted = client.on('message_deleted', ({ id, ok, session_id }) => {
    emitNow({
      kind: 'message_deleted',
      dbId: id,
      ok,
      sessionId: (session_id as string | undefined) ?? lastDeleteSessionId ?? lastSentSessionId
    })
  })

  const offSources = client.on('sources', ({ message_id, items, session_id }) => {
    emitNow({
      kind: 'sources',
      messageId: message_id,
      items,
      sessionId: session_id ?? messageSessions.get(message_id)
    })
  })

  const offReplyStart = client.on('reply_start', ({ message_id, session_id }) => {
    currentStream.set(message_id, {
      text: '',
      reasoning: '',
      startedAt: lastUserSentAt || Date.now()
    })
    const sid = session_id ?? lastSentSessionId
    if (sid) messageSessions.set(message_id, sid)
    emitNow({
      kind: 'reply_start',
      messageId: message_id,
      sessionId: sid
    })
  })

  const offReasoning = client.on('reasoning', ({ message_id, text, session_id }) => {
    const stream = currentStream.get(message_id)
    if (stream !== undefined) stream.reasoning += text
    else currentStream.set(message_id, { text: '', reasoning: text, startedAt: lastUserSentAt || Date.now() })
    emitLater({
      kind: 'reasoning',
      messageId: message_id,
      text,
      sessionId: session_id ?? messageSessions.get(message_id)
    })
  })

  const offToken = client.on('token', ({ message_id, text, session_id }) => {
    const stream = currentStream.get(message_id)
    if (stream !== undefined) stream.text += text
    else currentStream.set(message_id, { text, reasoning: '', startedAt: lastUserSentAt || Date.now() })
    emitLater({
      kind: 'token',
      messageId: message_id,
      text,
      sessionId: session_id ?? messageSessions.get(message_id)
    })
  })

  const offReplyEnd = client.on('reply_end', ({ message_id, full_text, interrupted, session_id }) => {
    flush()
    currentStream.delete(message_id)
    emitNow({
      kind: 'reply_end',
      messageId: message_id,
      fullText: full_text ?? '',
      interrupted: Boolean(interrupted),
      sessionId: session_id ?? messageSessions.get(message_id)
    })
    messageSessions.delete(message_id)
  })

  const offState = client.on('state', ({ state, session_id }) => {
    emitNow({ kind: 'state', state, sessionId: session_id ?? lastSentSessionId })
  })

  const offEmotion = client.on('emotion', ({ message_id, emotion, intensity, session_id }) => {
    // tap_head 的 emotion 没有 message_id：不是对话消息，不镜像
    if (!message_id) return
    emitNow({
      kind: 'emotion',
      messageId: message_id,
      emotion,
      intensity,
      sessionId: session_id ?? messageSessions.get(message_id)
    })
  })

  const offNotice = client.on('notice', ({ code, message, level, session_id }) => {
    emitNow({ kind: 'notice', code, message, level, sessionId: session_id ?? lastSentSessionId })
  })

  // 对话/连接错误也镜像到工作窗：用户可能正看着工作窗，不能只让宠物气泡提示
  const offError = client.on('error', ({ code, message, session_id }) => {
    emitNow({ kind: 'notice', code, message, level: 'error', sessionId: session_id ?? lastSentSessionId })
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

  // 对话列表 / 改名 / 删除：WS 回执转给主进程（主进程再 resolve 工作窗的 invoke）
  const offConversations = client.on('conversations', (data) => {
    if (conversationsPending === null) return
    const requestId = conversationsPending
    conversationsPending = null
    const rawItems = Array.isArray(data.items) ? (data.items as unknown[]) : []
    const items = rawItems
      .map((item) => (item !== null && typeof item === 'object' ? (item as Record<string, unknown>) : null))
      .filter((item): item is Record<string, unknown> => item !== null)
      .map((item) => ({
        id: String(item.id ?? ''),
        title: String(item.title ?? '新对话'),
        createdAt: Number(item.created_at ?? 0),
        updatedAt: Number(item.updated_at ?? 0),
        messageCount: Number(item.message_count ?? 0),
        kind: item.kind === 'pet' ? ('pet' as const) : ('chat' as const)
      }))
      .filter((item) => item.id.length > 0)
    bridge.work?.reportConversations?.({
      requestId,
      ok: true,
      items
    } satisfies WorkConversationsPayload)
  })

  const offConversationRenamed = client.on('conversation_renamed', (data) => {
    for (const [requestId, pending] of renamePending) {
      if (pending.id !== data.id) continue
      renamePending.delete(requestId)
      pending.resolve({
        requestId,
        id: data.id,
        ok: Boolean(data.ok),
        title: typeof data.title === 'string' ? data.title : undefined
      })
      return
    }
  })

  const offConversationDeleted = client.on('conversation_deleted', (data) => {
    for (const [requestId, pending] of deletePending) {
      if (pending.id !== data.id) continue
      deletePending.delete(requestId)
      pending.resolve({
        requestId,
        id: data.id,
        ok: Boolean(data.ok),
        reason: data.ok ? undefined : 'delete-failed'
      })
      return
    }
  })

  // 历史响应：与缓冲事件一起原子回给工作窗
  const offHistory = client.on('history', (data) => {
    if (historyPending === null) return
    const requestId = historyPending.requestId
    const requestedSessionId = historyPending.sessionId
    historyPending = null
    const buffered = historyBuffer
    historyBuffer = []
    const messages = Array.isArray(data.messages)
      ? (data.messages as unknown as WorkHistoryPayload['messages'])
      : []
    let live: WorkHistoryPayload['live']
    for (const [messageId, stream] of currentStream) {
      // 只回填本次请求会话的流式快照，避免别的对话的回复串进来
      if (requestedSessionId && messageSessions.get(messageId) !== requestedSessionId) continue
      live = {
        messageId,
        text: stream.text,
        reasoning: stream.reasoning,
        startedAt: stream.startedAt
      }
    }
    replyHistory({
      requestId,
      ok: true,
      sessionId:
        typeof data.session_id === 'string' ? data.session_id : requestedSessionId,
      messages,
      bufferedEvents: buffered,
      live
    })
  })

  return () => {
    setWorkActiveLocal(false)
    flush()
    offSendRequest?.()
    offHistoryRequest?.()
    offConversationsRequest?.()
    offRenameConversationRequest?.()
    offDeleteConversationRequest?.()
    offInterrupt?.()
    offFocusConversation?.()
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
    offConversations()
    offConversationRenamed()
    offConversationDeleted()
    renamePending.clear()
    deletePending.clear()
    conversationsPending = null
    if (flushTimer !== null) {
      window.clearTimeout(flushTimer)
      flushTimer = null
    }
  }
}
