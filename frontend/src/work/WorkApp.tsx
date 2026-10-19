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
  WorkBrowserTab,
  WorkMirrorEvent,
  WorkSourceItem
} from '../../electron/ipc/channels'
import { getPetBridge } from '../shared/pet-bridge'
import {
  EmptyState,
  IconButton,
  WindowFrame,
  WindowResizeHandles,
  WindowTitleBar,
  useFramelessMove,
  useFramelessResize
} from '../shared/ui'
import { renderMarkdownWithCitations } from '../board/markdown'
import Composer from './Composer'
import MessageNavigator from './MessageNavigator'
import ThinkingBlock from './ThinkingBlock'
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

/** 消息时间：年月日 时分（本地时区） */
function formatMessageTime(ms: number): string {
  const date = new Date(ms)
  if (Number.isNaN(date.getTime())) return ''
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** 写系统剪贴板：优先 Electron clipboard（file:// 下比 navigator.clipboard 稳） */
async function copyTextToClipboard(text: string): Promise<boolean> {
  if (!text) return false
  try {
    getPetBridge().system.copyText(text)
    return true
  } catch {
    try {
      await navigator.clipboard?.writeText(text)
      return true
    } catch (err) {
      console.warn('[work] 复制失败：', err)
      return false
    }
  }
}

const EMPTY_BROWSER_STATE: WorkBrowserState = {
  tabs: [],
  activeId: null,
  canGoBack: false,
  canGoForward: false
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname || url
  } catch {
    return url
  }
}

/** URL 去重/匹配：忽略 hash 与末尾斜杠（来源列表与搜索结果常差这一处） */
function normalizeUrl(value: string): string {
  try {
    const url = new URL(value)
    url.hash = ''
    return url.toString().replace(/\/$/, '')
  } catch {
    return value
  }
}

/** 20261018 / 2026-10-18 / 2026/10/18 → 2026/10/18 */
function prettyDate(value?: string): string {
  const text = value?.trim() ?? ''
  if (!text) return ''
  const digits = text.replace(/\D/g, '')
  if (digits.length >= 8) {
    return `${digits.slice(0, 4)}/${digits.slice(4, 6)}/${digits.slice(6, 8)}`
  }
  return text
}

/** 历史消息没有 sources 事件时，从“来源”行里尽量抠出标题/日期 */
function fallbackSource(text: string, url: string): { title: string; date: string } | null {
  const line = text
    .split('\n')
    .find((item) => item.includes(url) || item.includes(url.replace(/\/$/, '')))
  if (line === undefined) return null
  const title = line
    .replace(/^[\s\-*]*(?:\[\d+\]|\d+[.)、）．])\s*/, '')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[—–-]\s*$/, '')
    .trim()
  const dateMatch =
    line.match(/\b(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\b/) ??
    line.match(/\b(20\d{2})(\d{2})(\d{2})\b/)
  const date = dateMatch
    ? `${dateMatch[1]}/${dateMatch[2].padStart(2, '0')}/${dateMatch[3].padStart(2, '0')}`
    : ''
  return { title, date }
}

function reasonText(reason?: string): string {
  switch (reason) {
    case 'pet-unavailable':
      return '宠物窗口还没准备好，稍后再试～'
    case 'timeout':
      return '发送超时了，检查一下后端连接～'
    case 'bad-request':
      return '这条消息没能发出去，再试一次～'
    default:
      return '发送失败，请稍后再试～'
  }
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
  const [contextMenu, setContextMenu] = useState<{
    x: number
    y: number
    messageId: string
    selection: string
  } | null>(null)
  const [browser, setBrowser] = useState<WorkBrowserState>(EMPTY_BROWSER_STATE)
  const [tabsMenuOpen, setTabsMenuOpen] = useState(false)

  const move = useFramelessMove()
  const resize = useFramelessResize()

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
            <IconButton label="关闭" onClick={() => workBridge()?.hide()}>
              ×
            </IconButton>
          </>
        }
      >
        <div className="work-tabs" role="tablist" aria-label="工作模式标签">
            <div className={`work-tab${browsing ? '' : ' work-tab-active'}`}>
              <button
                type="button"
                className="work-tab-main"
                onClick={() => browserActivate(null)}
              >
                <span className="work-tab-title">对话</span>
              </button>
            </div>
            {visibleTabs.map((tab) => (
              <div
                key={tab.id}
                className={`work-tab${browser.activeId === tab.id ? ' work-tab-active' : ''}`}
                title={tab.url}
              >
                <button
                  type="button"
                  className="work-tab-main"
                  onClick={() => browserActivate(tab.id)}
                >
                  {tab.loading ? <span className="work-tab-spinner" aria-hidden="true" /> : null}
                  <span className="work-tab-title">{tab.title || hostOf(tab.url)}</span>
                </button>
                <button
                  type="button"
                  className="work-tab-close"
                  aria-label={`关闭 ${tab.title}`}
                  onClick={() => browserClose(tab.id)}
                >
                  ×
                </button>
              </div>
            ))}
            {hiddenTabs.length > 0 ? (
              <div
                className="work-tab-more-wrap"
                onPointerDown={(event) => event.stopPropagation()}
              >
                <button
                  type="button"
                  className={`work-tab-more${
                    hiddenTabs.some((tab) => tab.id === browser.activeId)
                      ? ' work-tab-active'
                      : ''
                  }`}
                  aria-haspopup="menu"
                  aria-expanded={tabsMenuOpen}
                  onClick={() => setTabsMenuOpen((open) => !open)}
                >
                  +{hiddenTabs.length} ▾
                </button>
                {tabsMenuOpen ? (
                  <div
                    className="work-tabs-menu"
                    role="menu"
                    onPointerDown={(event) => event.stopPropagation()}
                  >
                    {hiddenTabs.map((tab) => (
                      <div className="work-tabs-menu-row" key={tab.id}>
                        <button
                          type="button"
                          role="menuitem"
                          className="work-tabs-menu-main"
                          onClick={() => {
                            browserActivate(tab.id)
                            setTabsMenuOpen(false)
                          }}
                        >
                          {tab.title || hostOf(tab.url)}
                        </button>
                        <button
                          type="button"
                          className="work-tabs-menu-close"
                          aria-label={`关闭 ${tab.title}`}
                          onClick={() => browserClose(tab.id)}
                        >
                          ×
                        </button>
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            ) : null}
        </div>
      </WindowTitleBar>

      {browsing ? (
        <div className="work-browser-bar">
          <button
            type="button"
            className="work-browser-btn"
            disabled={!browser.canGoBack}
            aria-label="后退"
            title="后退"
            onClick={() => browserAction('back')}
          >
            ‹
          </button>
          <button
            type="button"
            className="work-browser-btn"
            disabled={!browser.canGoForward}
            aria-label="前进"
            title="前进"
            onClick={() => browserAction('forward')}
          >
            ›
          </button>
          <button
            type="button"
            className="work-browser-btn"
            aria-label="刷新"
            title="刷新"
            onClick={() => browserAction('reload')}
          >
            ↻
          </button>
          <span className="work-browser-url" title={activeTab?.url ?? ''}>
            {activeTab?.url ?? ''}
          </span>
          {activeTab?.error ? (
            <span className="work-browser-error" title={activeTab.error}>
              加载失败
            </span>
          ) : null}
          <button
            type="button"
            className="work-browser-btn"
            aria-label="在系统浏览器打开"
            title="在系统浏览器打开"
            onClick={() => browserAction('external')}
          >
            ↗
          </button>
        </div>
      ) : null}

      <div className={`work-chat-layer${browsing ? ' work-chat-hidden' : ''}`}>
        <div className="work-body">
          <div className="work-scroll pui-scroll" ref={scrollRef} onScroll={handleScroll}>
            {state.messages.length === 0 ? (
              <EmptyState
                fill
                icon="✦"
                title="开始一段认真的对话"
                hint="完整记录、历史导航，长回答也能慢慢看"
              />
            ) : (
              <div className="work-messages">
                {state.messages.map((message) =>
                  message.role === 'user' ? (
                    <UserMessage
                      key={message.id}
                      message={message}
                      flash={flashId === message.id}
                      setRef={setMessageRef(message.id)}
                      copied={copiedId === message.id}
                      onCopy={copyMessage}
                      onDelete={deleteMessage}
                      onContextMenu={openContextMenu}
                    />
                  ) : (
                    <AssistantMessage
                      key={message.id}
                      message={message}
                      copied={copiedId === message.id}
                      onCopy={copyMessage}
                      onDelete={deleteMessage}
                      onContextMenu={openContextMenu}
                      onLinkClick={handleMarkdownClick}
                    />
                  )
                )}
              </div>
            )}
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

      {(() => {
        if (browsing || contextMenu === null) return null
        const target = state.messages.find((item) => item.id === contextMenu.messageId)
        if (target === undefined) return null
        const left = Math.min(contextMenu.x, Math.max(8, window.innerWidth - 180))
        const top = Math.min(contextMenu.y, Math.max(8, window.innerHeight - 150))
        return (
          <div
            className="work-context-menu"
            style={{ left, top }}
            role="menu"
            onPointerDown={(event) => event.stopPropagation()}
            onContextMenu={(event) => event.preventDefault()}
          >
            <button
              type="button"
              className="work-context-item"
              role="menuitem"
              onClick={() => {
                void copyMessage(target)
                setContextMenu(null)
              }}
            >
              复制全文
            </button>
            <button
              type="button"
              className="work-context-item"
              role="menuitem"
              disabled={contextMenu.selection.trim().length === 0}
              onClick={() => {
                void copySelection(target, contextMenu.selection)
                setContextMenu(null)
              }}
            >
              复制选中
            </button>
            <div className="work-context-sep" role="separator" />
            <button
              type="button"
              className="work-context-item work-context-item-danger"
              role="menuitem"
              disabled={target.dbId === undefined || target.status === 'streaming'}
              title={
                target.status === 'streaming'
                  ? '回复完成后才能删除'
                  : target.dbId === undefined
                    ? '这条消息还没落库，稍后再删'
                    : undefined
              }
              onClick={() => {
                deleteMessage(target)
                setContextMenu(null)
              }}
            >
              删除此消息
            </button>
          </div>
        )
      })()}
    </WindowFrame>
  )
}

interface MessageActionProps {
  copied: boolean
  onCopy: (message: WorkMessage) => void
  onDelete: (message: WorkMessage) => void
  onContextMenu: (event: ReactMouseEvent, message: WorkMessage) => void
}

interface LinkPreviewState {
  url: string
  title: string
  snippet: string
  siteName: string
  date: string
  left: number
  top: number
  bottom: number
  /** 锚点（引用链接）顶部 Y：卡片渲染后按实际高度确认上方是否放得下 */
  anchorTop: number
  above: boolean
}

function UserMessage({
  message,
  flash,
  setRef,
  ...actions
}: MessageActionProps & {
  message: WorkMessage
  flash: boolean
  setRef: (node: HTMLDivElement | null) => void
}): ReactElement {
  return (
    <div
      className={`work-msg work-msg-user${flash ? ' work-flash' : ''}`}
      data-key={message.id}
      ref={setRef}
      onContextMenu={(event) => actions.onContextMenu(event, message)}
    >
      <div className="work-user-bubble">{message.text}</div>
      <MessageMeta
        message={message}
        align="end"
        copied={actions.copied}
        onCopy={actions.onCopy}
        onDelete={actions.onDelete}
      />
    </div>
  )
}

function AssistantMessage({
  message,
  onLinkClick,
  ...actions
}: MessageActionProps & {
  message: WorkMessage
  onLinkClick?: (event: ReactMouseEvent<HTMLDivElement>) => void
}): ReactElement {
  const [preview, setPreview] = useState<LinkPreviewState | null>(null)
  const hoverTimer = useRef<number | null>(null)

  const clearHoverTimer = (): void => {
    if (hoverTimer.current !== null) {
      window.clearTimeout(hoverTimer.current)
      hoverTimer.current = null
    }
  }

  useEffect(() => () => clearHoverTimer(), [])

  // 悬浮卡片按固定定位锚在链接旁；滚动后位置会失效，直接收起
  useEffect(() => {
    if (preview === null) return
    const hide = (): void => setPreview(null)
    document.addEventListener('scroll', hide, true)
    return () => document.removeEventListener('scroll', hide, true)
  }, [preview])

  const handleLinkOver = (event: ReactMouseEvent<HTMLDivElement>): void => {
    const target = event.target as HTMLElement
    const anchor = target.closest('a')
    if (anchor === null) return
    const url = anchor.href
    if (!/^https?:\/\//i.test(url)) return
    clearHoverTimer()
    const rect = anchor.getBoundingClientRect()
    hoverTimer.current = window.setTimeout(() => {
      hoverTimer.current = null
      const source = message.sources?.find(
        (item) => normalizeUrl(item.url) === normalizeUrl(url)
      )
      const fallback = fallbackSource(message.text, url)
      const width = 360 // 与 work.css 的 .work-link-preview width 保持一致（左右各留 8px）
      const left = Math.min(
        Math.max(8, rect.left + rect.width / 2 - width / 2),
        window.innerWidth - width - 8
      )
      const above = true // 默认向上：向下会挡住"接下来要读的正文"；渲染后测高，放不下再翻到向下
      setPreview({
        url,
        title:
          source?.title?.trim() ||
          fallback?.title ||
          anchor.getAttribute('title') ||
          hostOf(url),
        snippet: source?.snippet?.trim() ?? '',
        siteName: source?.site_name?.trim() ?? '',
        date: prettyDate(source?.date) || fallback?.date || '',
        left,
        top: rect.bottom + 8,
        bottom: window.innerHeight - rect.top + 8,
        anchorTop: rect.top,
        above
      })
    }, 220)
  }

  const handleLinkOut = (event: ReactMouseEvent<HTMLDivElement>): void => {
    const target = event.target as HTMLElement
    const anchor = target.closest('a')
    const related = event.relatedTarget
    if (anchor !== null && related instanceof Node && anchor.contains(related)) {
      return
    }
    clearHoverTimer()
    setPreview(null)
  }

  /** 卡片渲染后按实际高度确认：默认向上，仅当上方放不下（高度 + 8px 间距）时翻到向下 */
  const handlePreviewMeasure = useCallback((height: number): void => {
    setPreview((prev) => {
      if (prev === null || !prev.above || prev.anchorTop >= height + 8) return prev
      return { ...prev, above: false }
    })
  }, [])

  return (
    <div
      className="work-msg work-msg-assistant"
      data-key={message.id}
      onContextMenu={(event) => actions.onContextMenu(event, message)}
    >
      <ThinkingBlock
        reasoning={message.reasoning}
        streaming={message.status === 'streaming'}
        startedAt={message.sentAt}
        thinkingMs={message.thinkingMs}
      />
      {message.text.length > 0 ? (
        <div
          className="md-body work-markdown"
          onClick={(event) => {
            setPreview(null)
            onLinkClick?.(event)
          }}
          onMouseOver={handleLinkOver}
          onMouseOut={handleLinkOut}
          dangerouslySetInnerHTML={{
            __html: renderMarkdownWithCitations(message.text)
          }}
        />
      ) : message.status === 'streaming' ? (
        <span className="work-dots" aria-label="思考中">
          <span />
          <span />
          <span />
        </span>
      ) : null}
      {message.status === 'streaming' && message.text.length > 0 ? (
        <span className="work-cursor" aria-hidden="true" />
      ) : null}
      {message.interrupted === true ? <div className="work-note">（已打断）</div> : null}
      <MessageMeta
        message={message}
        align="start"
        copied={actions.copied}
        onCopy={actions.onCopy}
        onDelete={actions.onDelete}
      />
      {preview !== null ? (
        <LinkPreviewCard
          key={preview.url}
          preview={preview}
          onMeasure={handlePreviewMeasure}
        />
      ) : null}
    </div>
  )
}

/** 时间常显；复制/删除按钮由 CSS 在消息悬浮时显现 */
function MessageMeta({
  message,
  align,
  copied,
  onCopy,
  onDelete
}: {
  message: WorkMessage
  align: 'start' | 'end'
  copied: boolean
  onCopy: (message: WorkMessage) => void
  onDelete: (message: WorkMessage) => void
}): ReactElement {
  // 流式中的回答还没定稿，先不允许删（等 reply_end 落库后再删）
  const canDelete = message.dbId !== undefined && message.status !== 'streaming'
  return (
    <div className={`work-meta${align === 'end' ? ' work-meta-end' : ''}`}>
      <span className="work-time">{formatMessageTime(message.createdAt)}</span>
      <span className="work-actions">
        <button
          type="button"
          className="work-action"
          title="复制这条消息"
          onClick={() => onCopy(message)}
        >
          {copied ? '已复制' : '复制'}
        </button>
        <button
          type="button"
          className="work-action work-action-danger"
          title={canDelete ? '删除这条消息' : '回复完成后才能删除'}
          disabled={!canDelete}
          onClick={() => onDelete(message)}
        >
          删除
        </button>
      </span>
    </div>
  )
}

/** 引用/来源链接的悬浮卡片：站点 | 日期、标题、摘要（2026-10-19 用户定稿：不显示 URL 行） */
function LinkPreviewCard({
  preview,
  onMeasure
}: {
  preview: LinkPreviewState
  onMeasure: (height: number) => void
}): ReactElement {
  const [iconFailed, setIconFailed] = useState(false)
  const cardRef = useRef<HTMLDivElement | null>(null)
  const site = preview.siteName || hostOf(preview.url)
  const initial = site.replace(/^www\./i, '').charAt(0).toUpperCase() || '🔗'
  let origin = ''
  try {
    origin = new URL(preview.url).origin
  } catch {
    /* URL 非法：用字母占位 */
  }
  // 默认向上；渲染后、绘制前量实际高度，上方放不下时由 onMeasure 翻到向下（不闪）
  useLayoutEffect(() => {
    const height = cardRef.current?.offsetHeight ?? 0
    if (height > 0) onMeasure(height)
  })
  return (
    <div
      ref={cardRef}
      className={`work-link-preview${preview.above ? ' work-link-preview-above' : ''}`}
      style={
        preview.above
          ? { left: preview.left, bottom: preview.bottom }
          : { left: preview.left, top: preview.top }
      }
      role="tooltip"
    >
      <div className="work-link-preview-head">
        <span className="work-link-preview-icon">
          {origin && !iconFailed ? (
            <img
              src={`${origin}/favicon.ico`}
              alt=""
              onError={() => setIconFailed(true)}
            />
          ) : (
            <span>{initial}</span>
          )}
        </span>
        <span className="work-link-preview-site">{site}</span>
        {preview.date ? (
          <>
            <span className="work-link-preview-sep" aria-hidden="true">
              |
            </span>
            <span className="work-link-preview-date">{preview.date}</span>
          </>
        ) : null}
      </div>
      <div className="work-link-preview-title">{preview.title}</div>
      {preview.snippet ? (
        <div className="work-link-preview-snippet">{preview.snippet}</div>
      ) : null}
    </div>
  )
}
