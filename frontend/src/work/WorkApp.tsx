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
  PickedFile,
  WorkBrowserAction,
  WorkBrowserState,
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
import MessageContextMenu, { type ContextMenuState } from './conversation/MessageContextMenu'
import MessageList from './conversation/MessageList'
import WindowTabs from './conversation/WindowTabs'
import { copyTextToClipboard, reasonText } from './conversation/format'
import MessageNavigator from './MessageNavigator'
import TaskPanel from './task/TaskPanel'
import type { NavigatorAnchor } from './navigator'
import {
  EMPTY_WORK_STATE,
  navigatorMessages,
  workReducer,
  type WorkMessage
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
  /** 窗口最大化状态（2026-10-23：标题栏最大化/复原按钮） */
  const [maximized, setMaximized] = useState(false)
  /** 折叠态（最小化 = 屏幕右缘中间的小角标，2026-10-20）：由主进程通知，点角标展开 */
  const [folded, setFolded] = useState(false)

  // 通知点击：切到任务标签并聚焦指定任务
  useEffect(() => {
    let off: (() => void) | undefined
    try {
      off = getPetBridge().agent.onFocusTask((id) => {
        setTaskOpen(true)
        setFocusTaskId(id)
      })
    } catch {
      /* 旧 preload：没有该通道，静默降级 */
    }
    return () => off?.()
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
  const previews = useMemo(() => {
    const map: Record<string, string> = {}
    for (const item of userMessages) {
      // 悬浮预览尽量展示完整问题（过长时截断，避免 tooltip 撑满窗口）
      map[item.id] = item.text.replace(/\s+/g, ' ').slice(0, 200)
    }
    return map
  }, [userMessages])
  const streaming = state.streamingId !== null

  const requestHistory = useCallback(async (): Promise<void> => {
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
          limit: 200
        })
        if (payload.ok) {
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

  // 订阅镜像 + 就绪握手 + 首次历史回填
  useEffect(() => {
    const api = workBridge()
    if (!api) return
    const offEvent = api.onEvent((event: WorkMirrorEvent) => {
      // 历史回填期间丢弃实时事件：宠物窗已把它们放进 bufferedEvents/live 快照
      if (historyLoading.current) return
      dispatch({ type: 'mirror', event })
    })
    const offPetReady = api.onPetReady(() => {
      dispatch({ type: 'reset' })
      void requestHistory()
    })
    const offBrowser = api.onBrowserState?.((next) => setBrowser(next))
    api.ready()
    void requestHistory()
    return () => {
      offEvent()
      offPetReady()
      offBrowser?.()
    }
  }, [requestHistory])

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
      const attachments = files.map((file) => ({ path: file.path, name: file.name }))
      try {
        const result = await api.requestSend({
          requestId: makeRequestId(),
          text,
          attachments,
          options: { search }
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
    workBridge()?.interrupt()
  }, [])

  const handleJump = useCallback((id: string): void => {
    const node = messageRefs.current.get(id)
    if (node === undefined) return
    node.scrollIntoView({ behavior: 'smooth', block: 'start' })
    setFlashId(id)
    window.setTimeout(() => setFlashId((current) => (current === id ? null : current)), 700)
  }, [])

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

  const deleteMessage = useCallback((message: WorkMessage): void => {
    if (message.dbId === undefined) return
    workBridge()?.deleteMessage?.({ dbId: message.dbId })
  }, [])

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
        <div className="work-task-layer">
          <TaskPanel
            focusTaskId={focusTaskId}
            onFocusHandled={() => setFocusTaskId(null)}
          />
        </div>
      ) : null}

      <div className={`work-chat-layer${browsing || taskOpen ? ' work-chat-hidden' : ''}`}>
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
        />
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
