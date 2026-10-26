/**
 * 对话会话管理（2026-10-26 从 WorkApp 抽出）。
 *
 * 负责：拉历史、拉会话列表、切换/新建/改名/单删/批删、后台流式快照缓存。
 * 不持有状态：会话列表、当前 id、未读集合由 WorkApp 持有并传入，
 * 这样镜像事件订阅与渲染仍能直接读到。
 */
import { useCallback } from 'react'
import type { WorkConversationSummary } from '../../../../electron/ipc/channels'
import type { WorkAction, WorkState } from '../../store'
import { workBridge } from '../../work-bridge'
import { makeRequestId } from '../../request-id'

/** 后台快照最多保留几个（长时间使用避免无限增长） */
const MAX_BACKGROUND_SNAPSHOTS = 8

export interface WorkConversationsOptions {
  dispatch: React.Dispatch<WorkAction>
  /** 当前界面状态（存后台快照用） */
  stateRef: React.MutableRefObject<WorkState>
  /** 后台对话的流式快照 */
  backgroundStatesRef: React.MutableRefObject<Map<string, WorkState>>
  activeConversationRef: React.MutableRefObject<string>
  historyLoading: React.MutableRefObject<boolean>
  conversations: WorkConversationSummary[]
  setConversations: React.Dispatch<React.SetStateAction<WorkConversationSummary[]>>
  setActiveConversationId: React.Dispatch<React.SetStateAction<string>>
  setUnreadIds: React.Dispatch<React.SetStateAction<Set<string>>>
  /** 切换/新建会话后恢复滚动跟随 */
  stickToBottom: () => void
}

export interface WorkConversationsControls {
  requestHistory: (sessionId?: string) => Promise<void>
  requestConversations: () => Promise<WorkConversationSummary[] | null>
  refreshConversations: () => Promise<void>
  activateConversation: (id: string) => void
  stashActiveState: () => void
  switchConversation: (id: string) => Promise<void>
  newConversation: () => void
  renameConversation: (id: string, title: string) => Promise<void>
  deleteConversation: (id: string) => Promise<void>
  deleteConversations: (ids: string[]) => Promise<void>
}

export function useWorkConversations({
  dispatch,
  stateRef,
  backgroundStatesRef,
  activeConversationRef,
  historyLoading,
  conversations,
  setConversations,
  setActiveConversationId,
  setUnreadIds,
  stickToBottom
}: WorkConversationsOptions): WorkConversationsControls {
  const requestHistory = useCallback(
    async (sessionId?: string): Promise<void> => {
      const api = workBridge()
      if (!api?.requestHistory) {
        dispatch({
          type: 'mirror',
          event: {
            kind: 'notice',
            code: 'work_unavailable',
            message: '当前版本不支持工作模式，请重启应用后再试～',
            level: 'warn'
          }
        })
        return
      }
      historyLoading.current = true
      try {
        // 后端连接/宠物面接线可能晚于窗口打开：短重试，避免刚启动时显示空会话
        for (let attempt = 0; attempt < 3; attempt += 1) {
          const payload = await api.requestHistory({
            requestId: makeRequestId(),
            limit: 200,
            ...(sessionId ? { sessionId } : {})
          })
          if (payload.ok) {
            // 返回的会话与请求不一致（切换竞态）时丢弃
            if (sessionId && payload.sessionId && payload.sessionId !== sessionId) return
            if (sessionId && sessionId !== activeConversationRef.current) return
            dispatch({
              type: 'history',
              messages: payload.messages,
              bufferedEvents: payload.bufferedEvents,
              live: payload.live
            })
            return
          }
          if (payload.reason === 'pet-unavailable' || payload.reason === 'bad-request') {
            break
          }
          if (attempt < 2) {
            await new Promise((resolve) => window.setTimeout(resolve, 400))
          }
        }
        dispatch({
          type: 'mirror',
          event: {
            kind: 'notice',
            code: 'history_failed',
            message: '历史记录没拉下来，稍后再试～',
            level: 'warn'
          }
        })
      } catch (err) {
        console.warn('[work] 拉取历史失败：', err)
      } finally {
        historyLoading.current = false
      }
    },
    [activeConversationRef, dispatch, historyLoading]
  )

  /** 请求对话列表（失败返回 null，交给调用方决定是否保留旧列表） */
  const requestConversations = useCallback(async (): Promise<WorkConversationSummary[] | null> => {
    const api = workBridge()
    if (!api?.requestConversations) return null
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const payload = await api.requestConversations({ requestId: makeRequestId() })
        if (payload.ok) return payload.items
        if (payload.reason === 'pet-unavailable' || payload.reason === 'bad-request') break
      } catch (err) {
        console.warn('[work] 拉取对话列表失败：', err)
      }
      if (attempt < 2) await new Promise((resolve) => window.setTimeout(resolve, 400))
    }
    return null
  }, [])

  /** 刷新列表但不改变当前对话 */
  const refreshConversations = useCallback(async (): Promise<void> => {
    const items = await requestConversations()
    if (items !== null) setConversations(items)
  }, [requestConversations, setConversations])

  const activateConversation = useCallback(
    (id: string): void => {
      activeConversationRef.current = id
      setActiveConversationId(id)
      try {
        localStorage.setItem('pet.work.conversation', id)
      } catch {
        /* 忽略 */
      }
      setUnreadIds((prev) => {
        if (!prev.has(id)) return prev
        const next = new Set(prev)
        next.delete(id)
        return next
      })
      // 告诉主进程/后端谁在前台（宠物气泡/语音/表情只跟它走）
      workBridge()?.focusConversation?.(id)
    },
    [activeConversationRef, setActiveConversationId, setUnreadIds]
  )

  /** 把当前对话的界面状态存进后台快照（有内容就存，避免快速切换丢用户消息） */
  const stashActiveState = useCallback((): void => {
    const id = activeConversationRef.current
    if (!id) return
    const current = stateRef.current
    if (current.messages.length === 0 && !current.streamingId) return
    const cache = backgroundStatesRef.current
    cache.delete(id)
    cache.set(id, current)
    while (cache.size > MAX_BACKGROUND_SNAPSHOTS) {
      const oldest = cache.keys().next().value
      if (oldest === undefined) break
      cache.delete(oldest)
    }
  }, [activeConversationRef, backgroundStatesRef, stateRef])

  /** 切换对话：优先用后台流式快照，否则重置并拉历史 */
  const switchConversation = useCallback(
    async (id: string): Promise<void> => {
      if (!id || id === activeConversationRef.current) return
      stashActiveState()
      activateConversation(id)
      const background = backgroundStatesRef.current.get(id)
      if (background) {
        dispatch({ type: 'restore', state: background })
        backgroundStatesRef.current.delete(id)
        return
      }
      dispatch({ type: 'reset' })
      await requestHistory(id)
    },
    [
      activateConversation,
      activeConversationRef,
      backgroundStatesRef,
      dispatch,
      requestHistory,
      stashActiveState
    ]
  )

  /** 新建对话（草稿，发第一条消息时后端落库） */
  const newConversation = useCallback((): void => {
    stashActiveState()
    const id = globalThis.crypto?.randomUUID?.() ?? `c_${Date.now().toString(36)}`
    activateConversation(id)
    dispatch({ type: 'reset' })
    stickToBottom()
  }, [activateConversation, dispatch, stashActiveState, stickToBottom])

  const renameConversation = useCallback(
    async (id: string, title: string): Promise<void> => {
      const api = workBridge()
      if (!api?.renameConversation) return
      const result = await api.renameConversation({ requestId: makeRequestId(), id, title })
      if (!result.ok) {
        dispatch({
          type: 'mirror',
          event: {
            kind: 'notice',
            code: 'rename_failed',
            message: '改名没成功，稍后再试～',
            level: 'warn'
          }
        })
        return
      }
      void refreshConversations()
    },
    [dispatch, refreshConversations]
  )

  const deleteConversation = useCallback(
    async (id: string): Promise<void> => {
      if (!window.confirm('删除这个对话及全部消息？')) return
      const api = workBridge()
      if (!api?.deleteConversation) return
      const result = await api.deleteConversation({ requestId: makeRequestId(), id })
      if (!result.ok) {
        dispatch({
          type: 'mirror',
          event: {
            kind: 'notice',
            code: 'delete_failed',
            message: '删除失败：对话可能正在回复中～',
            level: 'warn'
          }
        })
        return
      }
      const remaining = conversations.filter((item) => item.id !== id)
      setConversations(remaining)
      if (id === activeConversationRef.current) {
        const next = remaining[0]?.id
        if (next) {
          activateConversation(next)
          dispatch({ type: 'reset' })
          await requestHistory(next)
        } else {
          newConversation()
        }
      }
    },
    [
      activateConversation,
      activeConversationRef,
      conversations,
      dispatch,
      newConversation,
      requestHistory,
      setConversations
    ]
  )

  // 批量删除：复用单条接口逐条串行删——后端对「正在回复中」的对话会拒绝，
  // 串行而非并发：一次只发一个请求，避免几十个请求同时挤压后端/WS。
  // 结果按条统计，失败项汇总提示，不让一条失败挡住其余删除。
  const deleteConversations = useCallback(
    async (ids: string[]): Promise<void> => {
      if (ids.length === 0) return
      if (!window.confirm(`删除选中的 ${ids.length} 个对话及全部消息？`)) return
      const api = workBridge()
      if (!api?.deleteConversation) return
      const deleted = new Set<string>()
      let failed = 0
      for (const id of ids) {
        try {
          const result = await api.deleteConversation({ requestId: makeRequestId(), id })
          if (result.ok) deleted.add(id)
          else failed += 1
        } catch {
          failed += 1
        }
      }
      if (deleted.size === 0) {
        dispatch({
          type: 'mirror',
          event: {
            kind: 'notice',
            code: 'delete_failed',
            message: '删除失败：选中的对话可能正在回复中～',
            level: 'warn'
          }
        })
        return
      }
      const remaining = conversations.filter((item) => !deleted.has(item.id))
      setConversations(remaining)
      if (activeConversationRef.current && deleted.has(activeConversationRef.current)) {
        const next = remaining[0]?.id
        if (next) {
          activateConversation(next)
          dispatch({ type: 'reset' })
          await requestHistory(next)
        } else {
          newConversation()
        }
      }
      if (failed > 0) {
        dispatch({
          type: 'mirror',
          event: {
            kind: 'notice',
            code: 'delete_failed',
            message: `已删除 ${deleted.size} 个，${failed} 个失败（可能正在回复中）～`,
            level: 'warn'
          }
        })
      }
    },
    [
      activateConversation,
      activeConversationRef,
      conversations,
      dispatch,
      newConversation,
      requestHistory,
      setConversations
    ]
  )

  return {
    requestHistory,
    requestConversations,
    refreshConversations,
    activateConversation,
    stashActiveState,
    switchConversation,
    newConversation,
    renameConversation,
    deleteConversation,
    deleteConversations
  }
}
