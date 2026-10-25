/**
 * 工作模式窗口（2026-10-18）：完整对话记录 + 右侧消息导航 + 单轮开关。
 *
 * 数据链路：宠物窗持有唯一 WS；本窗口的发送/历史/打断经主进程中继，
 * 对话镜像由宠物窗回报（见 electron/work + src/modules/work）。
 * 本组件只维护展示状态，不直接连 WS。
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactElement
} from 'react'
import type {
  AgentTaskDraftPayload,
  PickedFile,
  WorkBrowserAction,
  WorkBrowserState,
  WorkConversationSummary,
  WorkMirrorEvent
} from '../../electron/ipc/channels'
import { getPetBridge } from '../shared/pet-bridge'
import {
  IconButton,
  WindowFrame,
  WindowResizeHandles,
  WindowTitleBar,
  useFramelessMove,
  useFramelessResize
} from '../shared/ui'
import Composer from './Composer'
import BrowserBar from './conversation/BrowserBar'
import ConversationSidebar from './conversation/ConversationSidebar'
import MessageContextMenu, { type ContextMenuState } from './conversation/MessageContextMenu'
import MessageList from './conversation/MessageList'
import WindowTabs from './conversation/WindowTabs'
import { copyTextToClipboard, reasonText } from './conversation/format'
import MessageNavigator from './MessageNavigator'
import TaskPanel from './task/TaskPanel'
import type { NavigatorAnchor } from './navigator'
import { buildChatHistory } from './message/history'
import type { ComposerHistoryItem } from './message/history'
import {
  EMPTY_WORK_STATE,
  navigatorMessages,
  workReducer,
  type WorkMessage,
  type WorkState
} from './store'

/** 惰性取 work 段：旧 preload（主进程未重启）时返回 undefined，全部调用静默降级 */
function workBridge(): ReturnType<typeof getPetBridge>['work'] | undefined {
  try {
    return getPetBridge().work
  } catch {
    return undefined
  }
}

function makeRequestId(): string {
  const uuid = globalThis.crypto?.randomUUID?.()
  return uuid ?? `w_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`
}

const EMPTY_BROWSER_STATE: WorkBrowserState = {
  tabs: [],
  activeId: null,
  canGoBack: false,
  canGoForward: false
}

export default function WorkApp(): ReactElement {
  const [state, dispatch] = useReducer(workReducer, EMPTY_WORK_STATE)
  const [search, setSearch] = useState<boolean>(() => {
    try {
      return localStorage.getItem('work-search') !== '0'
    } catch {
      return true
    }
  })

  const scrollRef = useRef<HTMLDivElement>(null)
  const messageRefs = useRef(new Map<string, HTMLElement>())
  const historyLoading = useRef(false)
  const nearBottom = useRef(true)
  const metricsKey = useRef('')

  const [scrollTop, setScrollTop] = useState(0)
  const [anchors, setAnchors] = useState<NavigatorAnchor[]>([])
  const [contentHeight, setContentHeight] = useState(0)
  const [viewportHeight, setViewportHeight] = useState(0)
  const [flashId, setFlashId] = useState<string | null>(null)
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)
  const [browser, setBrowser] = useState<WorkBrowserState>(EMPTY_BROWSER_STATE)
  const [tabsMenuOpen, setTabsMenuOpen] = useState(false)
  /** 任务标签是否在前（2026-10-23）：与对话/网页标签互斥，对话模式行为完全不变 */
  const [taskOpen, setTaskOpen] = useState(false)
  /** 通知点击要聚焦的任务（传给 TaskPanel 选中后清空） */
  const [focusTaskId, setFocusTaskId] = useState<string | null>(null)
  /** 宠物窗带文件的消息（任务草稿）；TaskPanel 处理后清空 */
  const [taskDraft, setTaskDraft] = useState<AgentTaskDraftPayload | null>(null)
  /** 正文缩放（Ctrl+滚轮；只看内容层，标题栏/标签栏不缩放） */
  const [zoom, setZoom] = useState<number>(() => {
    try {
      const saved = Number(localStorage.getItem('pet.work.zoom'))
      return Number.isFinite(saved) && saved >= 0.7 && saved <= 1.6 ? saved : 1
    } catch {
      return 1
    }
  })
  /** 对话列表（左栏）与当前对话 */
  const [conversations, setConversations] = useState<WorkConversationSummary[]>([])
  const [activeConversationId, setActiveConversationId] = useState('')
  const [unreadIds, setUnreadIds] = useState<Set<string>>(() => new Set())
  const activeConversationRef = useRef('')
  const stateRef = useRef(state)
  /** 切走时仍在流式的对话快照（后台继续收事件；支持多个对话同时回复） */
  const backgroundStatesRef = useRef<Map<string, WorkState>>(new Map())
  /** 正在回复的对话集合（每会话独立） */
  const [streamingIds, setStreamingIds] = useState<Set<string>>(() => new Set())
  const streamingIdsRef = useRef<Set<string>>(new Set())

  const markStreaming = useCallback((id: string, active: boolean): void => {
    const next = new Set(streamingIdsRef.current)
    if (active) next.add(id)
    else next.delete(id)
    streamingIdsRef.current = next
    setStreamingIds(next)
  }, [])

  useEffect(() => {
    stateRef.current = state
  }, [state])
  /** 窗口最大化状态（2026-10-23：标题栏最大化/复原按钮） */
  const [maximized, setMaximized] = useState(false)
  /** 折叠态（最小化 = 屏幕右缘中间的小角标，2026-10-20）：由主进程通知，点角标展开 */
  const [folded, setFolded] = useState(false)

  // 正文缩放：Ctrl+滚轮（0.7–1.6，步进 0.1），Ctrl+0 复位；持久化到本机
  useEffect(() => {
    const apply = (next: number): void => {
      const clamped = Math.min(1.6, Math.max(0.7, Math.round(next * 10) / 10))
      setZoom(clamped)
      try {
        localStorage.setItem('pet.work.zoom', String(clamped))
      } catch {
        /* 隐私模式：仅本次生效 */
      }
    }
    const onWheel = (event: WheelEvent): void => {
      if (!event.ctrlKey) return
      event.preventDefault()
      setZoom((prev) => {
        const next = Math.min(
          1.6,
          Math.max(0.7, Math.round((prev + (event.deltaY < 0 ? 0.1 : -0.1)) * 10) / 10)
        )
        try {
          localStorage.setItem('pet.work.zoom', String(next))
        } catch {
          /* 同上 */
        }
        return next
      })
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.ctrlKey && event.key === '0') {
        event.preventDefault()
        apply(1)
      }
    }
    // passive:false：必须能 preventDefault，避免 Chromium 自己缩放整页
    window.addEventListener('wheel', onWheel, { passive: false })
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('wheel', onWheel)
      window.removeEventListener('keydown', onKey)
    }
  }, [])

  // 通知点击：切到任务标签并聚焦指定任务；宠物窗带文件的消息：切任务标签并交给 TaskPanel
  useEffect(() => {
    let offFocus: (() => void) | undefined
    let offDraft: (() => void) | undefined
    try {
      const agent = getPetBridge().agent
      offFocus = agent.onFocusTask((id) => {
        setTaskOpen(true)
        setFocusTaskId(id)
      })
      offDraft = agent.onTaskDraft?.((draft) => {
        setTaskOpen(true)
        setTaskDraft(draft)
      })
    } catch {
      /* 旧 preload：没有该通道，静默降级 */
    }
    return () => {
      offFocus?.()
      offDraft?.()
    }
  }, [])

  // 最大化状态：挂载时校准 + 订阅主进程变化
  useEffect(() => {
    const bridge = workBridge()
    if (!bridge?.isMaximized) return
    let alive = true
    void bridge.isMaximized().then((value) => {
      if (alive) setMaximized(value)
    })
    const off = bridge.onMaximizedChanged(setMaximized)
    return () => {
      alive = false
      off()
    }
  }, [])

  const move = useFramelessMove()
  const resize = useFramelessResize()

  // 折叠态同步（主进程折叠/展开时推送；页面重载后主进程在 ready 时补发一次）
  useEffect(() => {
    const off = workBridge()?.onFolded?.((value) => setFolded(Boolean(value)))
    return () => off?.()
  }, [])

  const userMessages = useMemo(() => navigatorMessages(state.messages), [state.messages])
  const chatHistory = useMemo(() => buildChatHistory(state.messages), [state.messages])
  const previews = useMemo(() => {
    const map: Record<string, string> = {}
    for (const item of userMessages) {
      // 悬浮预览尽量展示完整问题（过长时截断，避免 tooltip 撑满窗口）
      map[item.id] = item.text.replace(/\s+/g, ' ').slice(0, 200)
    }
    return map
  }, [userMessages])
  const streaming = state.streamingId !== null
  const activeConversation = conversations.find((item) => item.id === activeConversationId)
  const activeTitle = activeConversation?.title ?? '新对话'
  const draftConversation = activeConversation === undefined

  const requestHistory = useCallback(async (sessionId?: string): Promise<void> => {
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
  }, [])

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
  }, [requestConversations])

  const activateConversation = useCallback((id: string): void => {
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
  }, [])

  /** 把当前对话的界面状态存进后台快照（有内容就存，避免快速切换丢用户消息） */
  const stashActiveState = useCallback((): void => {
    const id = activeConversationRef.current
    if (!id) return
    const current = stateRef.current
    if (current.messages.length === 0 && !current.streamingId) return
    const cache = backgroundStatesRef.current
    cache.delete(id)
    cache.set(id, current)
    // 只保留最近 8 个快照，避免长时间使用后无限增长
    while (cache.size > 8) {
      const oldest = cache.keys().next().value
      if (oldest === undefined) break
      cache.delete(oldest)
    }
  }, [])

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
    [activateConversation, requestHistory, stashActiveState]
  )

  /** 新建对话（草稿，发第一条消息时后端落库） */
  const newConversation = useCallback((): void => {
    stashActiveState()
    const id = globalThis.crypto?.randomUUID?.() ?? `c_${Date.now().toString(36)}`
    activateConversation(id)
    dispatch({ type: 'reset' })
    nearBottom.current = true
  }, [activateConversation, stashActiveState])

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
    [refreshConversations]
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
    [activateConversation, conversations, newConversation, requestHistory]
  )

  // 订阅镜像 + 就绪握手 + 首次历史回填
  useEffect(() => {
    const api = workBridge()
    if (!api) return
    const offEvent = api.onEvent((event: WorkMirrorEvent) => {
      const target = event.sessionId ?? activeConversationRef.current
      if (event.kind === 'reply_start') markStreaming(target, true)
      if (event.kind === 'reply_end' || (event.kind === 'state' && event.state === 'idle')) {
        markStreaming(target, false)
      }
      if (target !== activeConversationRef.current) {
        // 后台对话：写进独立快照，完成时标未读；不影响当前窗口
        const previous =
          backgroundStatesRef.current.get(target) ?? EMPTY_WORK_STATE
        backgroundStatesRef.current.set(
          target,
          workReducer(previous, { type: 'mirror', event })
        )
        if (event.kind === 'reply_end') {
          setUnreadIds((prev) => new Set(prev).add(target))
          void refreshConversations()
        }
        return
      }
      // 历史回填期间丢弃实时事件：宠物窗已把它们放进 bufferedEvents/live 快照
      if (historyLoading.current) return
      dispatch({ type: 'mirror', event })
      if (event.kind === 'reply_end' || event.kind === 'message_saved') {
        void refreshConversations()
      }
    })
    const offPetReady = api.onPetReady(() => {
      dispatch({ type: 'reset' })
      void refreshConversations().then(() => requestHistory(activeConversationRef.current))
    })
    const offBrowser = api.onBrowserState?.((next) => setBrowser(next))
    api.ready()

    const boot = async (): Promise<void> => {
      const items = await requestConversations()
      if (items !== null) setConversations(items)
      let saved: string | null = null
      try {
        saved = localStorage.getItem('pet.work.conversation')
      } catch {
        saved = null
      }
      const inList = saved !== null && (items?.some((item) => item.id === saved) ?? false)
      // 没有保存过选择时，优先最近的普通对话；只有宠物会话/空列表才落到宠物会话
      const fallbackId =
        items?.find((item) => item.kind !== 'pet')?.id ?? items?.[0]?.id ?? null
      const id = inList
        ? (saved as string)
        : (fallbackId ??
          (items === null ? saved : null) ??
          globalThis.crypto?.randomUUID?.() ??
          `c_${Date.now().toString(36)}`)
      activateConversation(id)
      dispatch({ type: 'reset' })
      await requestHistory(id)
    }
    void boot()

    return () => {
      offEvent()
      offPetReady()
      offBrowser?.()
    }
  }, [
    activateConversation,
    markStreaming,
    refreshConversations,
    requestConversations,
    requestHistory
  ])

  // 提示自动消失（错误保留到用户关闭/下一次提示，避免一闪而过看不到原因）
  useEffect(() => {
    if (state.notice === null || state.notice.kind === 'error') return
    const timer = window.setTimeout(() => dispatch({ type: 'clear-notice' }), 6000)
    return () => window.clearTimeout(timer)
  }, [state.notice])

  // 开关持久化
  useEffect(() => {
    try {
      localStorage.setItem('work-search', search ? '1' : '0')
    } catch {
      /* 存储不可用：仅本次生效 */
    }
  }, [search])

  /** 重新测量滚动高度、导航锚点与当前位置 */
  const measure = useCallback((): void => {
    const element = scrollRef.current
    if (element === null) return
    const nextAnchors: NavigatorAnchor[] = []
    const containerTop = element.getBoundingClientRect().top
    for (const item of userMessages) {
      const node = messageRefs.current.get(item.id)
      if (node === undefined) continue
      nextAnchors.push({
        id: item.id,
        offsetTop: node.getBoundingClientRect().top - containerTop + element.scrollTop,
        height: node.getBoundingClientRect().height
      })
    }
    const top = element.scrollTop
    const height = element.scrollHeight
    const viewport = element.clientHeight
    const key = `${top}|${height}|${viewport}|${nextAnchors.map((a) => `${a.id}:${Math.round(a.offsetTop)}`).join(',')}`
    if (key === metricsKey.current) return
    metricsKey.current = key
    setScrollTop(top)
    setContentHeight(height)
    setViewportHeight(viewport)
    setAnchors(nextAnchors)
  }, [userMessages])

  // 消息变化/布局变化后测量（下一帧，等 DOM 完成排版）
  useLayoutEffect(() => {
    const frame = window.requestAnimationFrame(measure)
    return () => window.cancelAnimationFrame(frame)
  }, [state.messages, measure])

  // 新消息：用户停在底部附近时自动跟随
  useLayoutEffect(() => {
    const element = scrollRef.current
    if (element === null) return
    if (!nearBottom.current) return
    element.scrollTop = element.scrollHeight
  }, [state.messages])

  const handleScroll = useCallback((): void => {
    const element = scrollRef.current
    if (element === null) return
    nearBottom.current =
      element.scrollHeight - element.scrollTop - element.clientHeight < 80
    measure()
  }, [measure])

  const handleSend = useCallback(
    async (text: string, files: PickedFile[]): Promise<boolean> => {
      const api = workBridge()
      if (!api?.requestSend) {
        dispatch({
          type: 'mirror',
          event: {
            kind: 'notice',
            code: 'work_unavailable',
            message: '当前版本不支持工作模式，请重启应用后再试～',
            level: 'warn'
          }
        })
        return false
      }
      if (streamingIdsRef.current.has(activeConversationRef.current)) {
        dispatch({
          type: 'mirror',
          event: {
            kind: 'notice',
            code: 'busy_conversation',
            message: '这个对话正在回复中，等它结束后再发～',
            level: 'warn'
          }
        })
        return false
      }
      const attachments = files.map((file) => ({ path: file.path, name: file.name }))
      try {
        const result = await api.requestSend({
          requestId: makeRequestId(),
          text,
          attachments,
          options: { search },
          sessionId: activeConversationRef.current || undefined
        })
        if (!result.ok) {
          dispatch({
            type: 'mirror',
            event: {
              kind: 'notice',
              code: 'send_failed',
              message: reasonText(result.reason),
              level: 'warn'
            }
          })
          return false
        }
        nearBottom.current = true
        return true
      } catch (err) {
        console.warn('[work] 发送失败：', err)
        dispatch({
          type: 'mirror',
          event: {
            kind: 'notice',
            code: 'send_failed',
            message: reasonText(),
            level: 'warn'
          }
        })
        return false
      }
    },
    [search]
  )

  const handleInterrupt = useCallback((): void => {
    workBridge()?.interrupt(activeConversationRef.current || undefined)
  }, [])

  const scrollToMessage = useCallback(
    (id: string, block: ScrollLogicalPosition = 'start'): void => {
      const node = messageRefs.current.get(id)
      if (node === undefined) return
      node.scrollIntoView({ behavior: 'smooth', block })
      setFlashId(id)
      window.setTimeout(() => setFlashId((current) => (current === id ? null : current)), 700)
    },
    []
  )

  const handleJump = useCallback(
    (id: string): void => {
      scrollToMessage(id)
    },
    [scrollToMessage]
  )

  // 历史时间点击：居中显示，避免目标贴视口边缘被裁掉
  const locateChatHistoryItem = useCallback(
    (item: ComposerHistoryItem): void => {
      scrollToMessage(item.id, 'center')
    },
    [scrollToMessage]
  )

  const markCopied = useCallback((id: string): void => {
    setCopiedId(id)
    window.setTimeout(() => setCopiedId((current) => (current === id ? null : current)), 1500)
  }, [])

  /** 复制整条：助手复制 Markdown 源文，用户复制纯文本 */
  const copyMessage = useCallback(
    async (message: WorkMessage): Promise<void> => {
      if (await copyTextToClipboard(message.text)) markCopied(message.id)
    },
    [markCopied]
  )

  /** 复制选中文本（右键时捕获，避免菜单点击后选区丢失） */
  const copySelection = useCallback(
    async (message: WorkMessage, selection: string): Promise<void> => {
      if (await copyTextToClipboard(selection)) markCopied(message.id)
    },
    [markCopied]
  )

  const deleteMessage = useCallback(
    (message: WorkMessage): void => {
      if (message.dbId === undefined) return
      workBridge()?.deleteMessage?.({
        dbId: message.dbId,
        sessionId: activeConversationRef.current || undefined
      })
    },
    []
  )

  const openContextMenu = useCallback(
    (event: ReactMouseEvent, message: WorkMessage): void => {
      event.preventDefault()
      const selection = window.getSelection()?.toString() ?? ''
      setContextMenu({
        x: event.clientX,
        y: event.clientY,
        messageId: message.id,
        selection
      })
    },
    []
  )

  // 右键菜单：点击空白 / Esc / 滚动即关闭
  useEffect(() => {
    if (contextMenu === null) return
    const close = (): void => setContextMenu(null)
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') close()
    }
    document.addEventListener('pointerdown', close)
    document.addEventListener('keydown', onKeyDown)
    window.addEventListener('scroll', close, true)
    return () => {
      document.removeEventListener('pointerdown', close)
      document.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('scroll', close, true)
    }
  }, [contextMenu])

  // 标签溢出菜单：点击空白 / Esc 关闭
  useEffect(() => {
    if (!tabsMenuOpen) return
    const close = (): void => setTabsMenuOpen(false)
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') close()
    }
    document.addEventListener('pointerdown', close)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', close)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [tabsMenuOpen])

  // +N 下拉菜单是 DOM，原生网页视图永远在 DOM 之上：菜单打开时临时隐藏视图
  useEffect(() => {
    workBridge()?.browserOverlay?.(tabsMenuOpen)
  }, [tabsMenuOpen])

  const browsing = browser.activeId !== null
  const activeTab = browser.tabs.find((tab) => tab.id === browser.activeId)
  const visibleTabs = useMemo(() => {
    const limit = 3
    const visible = browser.tabs.slice(0, limit)
    const active = browser.tabs.find((tab) => tab.id === browser.activeId)
    if (active !== undefined && !visible.some((tab) => tab.id === active.id)) {
      if (visible.length >= limit) visible[limit - 1] = active
      else visible.push(active)
    }
    return visible
  }, [browser.tabs, browser.activeId])
  const hiddenTabs = browser.tabs.filter(
    (tab) => !visibleTabs.some((item) => item.id === tab.id)
  )

  const browserOpen = useCallback((url: string, label?: string): void => {
    workBridge()?.browserOpen?.({ url, label })
  }, [])

  const browserClose = useCallback((id: string): void => {
    workBridge()?.browserClose?.(id)
  }, [])

  const browserActivate = useCallback((id: string | null): void => {
    workBridge()?.browserActivate?.(id)
  }, [])

  const browserAction = useCallback((action: WorkBrowserAction): void => {
    workBridge()?.browserAction?.(action)
  }, [])

  /** 正文链接点击 → 内嵌浏览器新标签；bridge 不可用时保持默认（主进程会走系统浏览器） */
  const handleMarkdownClick = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>): void => {
      const target = event.target as HTMLElement
      const anchor = target.closest('a')
      if (anchor === null) return
      const href = anchor.href
      if (!/^https?:\/\//i.test(href)) return
      if (!workBridge()?.browserOpen) return
      event.preventDefault()
      browserOpen(href, anchor.getAttribute('title') ?? undefined)
    },
    [browserOpen]
  )

  const setMessageRef = useCallback(
    (id: string) =>
      (node: HTMLDivElement | null): void => {
        if (node === null) messageRefs.current.delete(id)
        else messageRefs.current.set(id, node)
      },
    []
  )

  // 折叠态：只画右缘小角标（窗口已被主进程缩成 24×140），点击恢复原窗口
  if (folded) {
    const unfold = (): void => {
      workBridge()?.unfold?.()
    }
    return (
      <WindowFrame variant="plain" className="work-root work-root-folded">
        <div
          className="work-badge"
          role="button"
          tabIndex={0}
          title="展开工作模式"
          onClick={unfold}
          onKeyDown={(e) => {
            if (e.key === ' ' || e.key === 'Enter') {
              e.preventDefault()
              unfold()
            }
          }}
        >
          <ChatIcon />
          <span className="work-badge-label">工作</span>
        </div>
      </WindowFrame>
    )
  }

  return (
    <WindowFrame variant="solid" className="work-root">
      <WindowResizeHandles onResizeStart={resize.onResizeStart} />
      <WindowTitleBar
        title="工作模式"
        subtitle={streaming && !browsing ? '回复中…' : undefined}
        dragHandlers={{ onPointerDown: move.onPointerDown }}
        actions={
          <>
            <IconButton label="最小化" onClick={() => workBridge()?.minimize()}>
              –
            </IconButton>
            <IconButton
              label={maximized ? '复原' : '最大化'}
              onClick={() => workBridge()?.maximizeToggle()}
            >
              {maximized ? '❐' : '□'}
            </IconButton>
            <IconButton label="关闭" onClick={() => workBridge()?.hide()}>
              ×
            </IconButton>
          </>
        }
      >
        <WindowTabs
          visibleTabs={visibleTabs}
          hiddenTabs={hiddenTabs}
          activeId={browser.activeId}
          browsing={browsing}
          taskOpen={taskOpen}
          menuOpen={tabsMenuOpen}
          onToggleMenu={() => setTabsMenuOpen((open) => !open)}
          onChat={() => {
            setTaskOpen(false)
            browserActivate(null)
          }}
          onTask={() => {
            browserActivate(null)
            setTaskOpen(true)
          }}
          onActivate={(id) => {
            setTaskOpen(false)
            browserActivate(id)
            setTabsMenuOpen(false)
          }}
          onClose={browserClose}
        />
      </WindowTitleBar>

      {browsing ? (
        <BrowserBar
          tab={activeTab}
          canGoBack={browser.canGoBack}
          canGoForward={browser.canGoForward}
          onAction={browserAction}
        />
      ) : null}

      {taskOpen ? (
        <div
          className={`work-task-layer${browsing ? ' work-chat-hidden' : ''}`}
          style={{ zoom }}
        >
          <TaskPanel
            focusTaskId={focusTaskId}
            onFocusHandled={() => setFocusTaskId(null)}
            onLinkClick={handleMarkdownClick}
            draft={taskDraft}
            onDraftHandled={() => setTaskDraft(null)}
          />
        </div>
      ) : null}

      <div
        className={`work-chat-layer${browsing || taskOpen ? ' work-chat-hidden' : ''}`}
        style={{ zoom }}
      >
        <div className="task-layout">
          <ConversationSidebar
            items={conversations}
            activeId={activeConversationId}
            draft={draftConversation}
            unread={unreadIds}
            streaming={streamingIds}
            onNew={newConversation}
            onSelect={(id) => void switchConversation(id)}
            onRename={(id, title) => void renameConversation(id, title)}
            onDelete={(id) => void deleteConversation(id)}
          />
          <div className="conv-main">
            <header className="task-head task-head-slim">
              <div className="task-head-main">
                <span className="conv-title" title={activeTitle}>
                  {activeTitle}
                </span>
                {streaming ? (
                  <span className="conv-streaming">回复中…</span>
                ) : streamingIds.size > 0 ? (
                  <span className="conv-streaming">{streamingIds.size} 个对话回复中…</span>
                ) : null}
              </div>
              <div className="task-head-actions">
                <button type="button" className="task-btn" onClick={newConversation}>
                  新对话
                </button>
              </div>
            </header>
            <div className="work-body">
              <div className="work-scroll pui-scroll" ref={scrollRef} onScroll={handleScroll}>
                <MessageList
                  messages={state.messages}
                  flashId={flashId}
                  copiedId={copiedId}
                  setMessageRef={setMessageRef}
                  onCopy={copyMessage}
                  onDelete={deleteMessage}
                  onContextMenu={openContextMenu}
                  onLinkClick={handleMarkdownClick}
                />
              </div>
              <MessageNavigator
                anchors={anchors}
                contentHeight={contentHeight}
                viewportHeight={viewportHeight}
                scrollTop={scrollTop}
                previews={previews}
                onJump={handleJump}
                visible={anchors.length >= 1}
              />
            </div>

            <Composer
              streaming={streaming}
              search={search}
              onSearchChange={setSearch}
              onSend={handleSend}
              onStop={handleInterrupt}
              notice={state.notice}
              onDismissNotice={() => dispatch({ type: 'clear-notice' })}
              history={chatHistory}
              scopeKey={`${activeConversationId ?? 'draft'}:${taskOpen ? 'task' : 'chat'}`}
              onLocateHistory={locateChatHistoryItem}
            />
          </div>
        </div>
      </div>

      <MessageContextMenu
        menu={browsing ? null : contextMenu}
        message={state.messages.find((item) => item.id === contextMenu?.messageId)}
        onCopy={(message) => {
          void copyMessage(message)
          setContextMenu(null)
        }}
        onCopySelection={(message, selection) => {
          void copySelection(message, selection)
          setContextMenu(null)
        }}
        onDelete={(message) => {
          deleteMessage(message)
          setContextMenu(null)
        }}
      />

    </WindowFrame>
  )
}

/** 折叠角标图标：对话气泡（线稿；颜色随 currentColor = 角标前景色） */
function ChatIcon(): JSX.Element {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 9.9 9.9 0 0 1-4.2-.9L3 20.5l1.4-4.2A8.4 8.4 0 0 1 12 3.1a8.4 8.4 0 0 1 9 8.4z" />
      <path d="M8.5 11.5h.01M12 11.5h.01M15.5 11.5h.01" />
    </svg>
  )
}
