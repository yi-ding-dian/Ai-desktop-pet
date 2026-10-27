/**
 * 工作模式窗口（2026-10-18）：完整对话记录 + 右侧消息导航 + 单轮开关。
 *
 * 数据链路：宠物窗持有唯一 WS；本窗口的发送/历史/打断经主进程中继，
 * 对话镜像由宠物窗回报（见 electron/work + src/modules/work-mode）。
 * 本组件只维护展示状态，不直接连 WS。
 *
 * 体量说明（2026-10-26，按《代码组织规范》审视过）：
 * 已拆出会话管理（sessions/）、消息操作与发送（messages/）、滚动导航（scroll/）、
 * 浏览器标签（browser/）。剩余约 640 行主要是**工作窗生命周期编排**：
 * 镜像事件订阅、后台快照路由、启动握手、持久化——这些 effect 与状态机深度耦合，
 * 拆出去需要把 10+ 个 ref/state 作为参数传入，反而更难追踪；职责仍是单一的
 * 「把主进程事件路由进本地状态机」，故保留并在此说明。
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactElement
} from 'react'
import type {
  AgentTaskDraftPayload,
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
import MessageContextMenu from './conversation/MessageContextMenu'
import MessageList from './conversation/MessageList'
import WindowTabs from './conversation/WindowTabs'
import { copyTextToClipboard } from './conversation/format'
import MessageNavigator from './MessageNavigator'
import TaskPanel from './task/TaskPanel'
import { buildChatHistory } from './input/chat-history'
import type { ComposerHistoryItem } from './input/chat-history'
import {
  EMPTY_WORK_STATE,
  navigatorMessages,
  workReducer,
  type WorkMessage,
  type WorkState
} from './store'

import { workBridge } from './work-bridge'
import { useWorkScroll } from './conversation/scroll/useWorkScroll'
import { useWorkMessages } from './conversation/messages/useWorkMessages'
import { useWorkConversations } from './conversation/sessions/useWorkConversations'
import { useWorkSend } from './conversation/messages/useWorkSend'
import { useWorkBrowserTabs } from './conversation/browser/useWorkBrowserTabs'




export default function WorkApp(): ReactElement {
  const [state, dispatch] = useReducer(workReducer, EMPTY_WORK_STATE)
  const [search, setSearch] = useState<boolean>(() => {
    try {
      return localStorage.getItem('work-search') !== '0'
    } catch {
      return true
    }
  })

  const historyLoading = useRef(false)

  /** 内置浏览器标签（2026-10-26 抽到 useWorkBrowserTabs） */
  const {
    browser,
    browsing,
    activeTab,
    visibleTabs,
    hiddenTabs,
    tabsMenuOpen,
    setTabsMenuOpen,
    open: browserOpen,
    close: browserClose,
    activate: browserActivate,
    action: browserAction,
    handleContentClick: handleMarkdownClick
  } = useWorkBrowserTabs()
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
  /** 消息操作与右键菜单（2026-10-26 抽到 useWorkMessages） */
  const {
    copiedId,
    contextMenu,
    setContextMenu,
    copyMessage,
    copySelection,
    deleteMessage,
    openContextMenu
  } = useWorkMessages({ activeConversationRef })
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

  // 选中文本 → Ctrl/Cmd+C：无应用菜单时 Chromium 的原生复制可能失效，这里显式写剪贴板。
  // 输入框/可编辑区不接管，保留原生行为。
  useEffect(() => {
    const onCopyKey = (event: KeyboardEvent): void => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return
      if (event.key.toLowerCase() !== 'c') return
      const target = event.target as HTMLElement | null
      // 输入框：用 selectionStart/End 取选中段（原生快捷键在无菜单窗口里也不稳）
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
        const start = target.selectionStart ?? 0
        const end = target.selectionEnd ?? 0
        if (start === end) return
        event.preventDefault()
        void copyTextToClipboard(target.value.slice(start, end))
        return
      }
      if (target?.closest('[contenteditable="true"]')) return
      const selection = window.getSelection()?.toString() ?? ''
      if (!selection) return
      event.preventDefault()
      void copyTextToClipboard(selection)
    }
    window.addEventListener('keydown', onCopyKey)
    return () => window.removeEventListener('keydown', onCopyKey)
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
  /** 滚动/测量/导航/历史定位（2026-10-26 抽到 useWorkScroll） */
  const {
    scrollRef,
    messageRefs,
    scrollTop,
    anchors,
    contentHeight,
    viewportHeight,
    flashId,
    handleScroll,
    handleJump,
    locateHistoryItem,
    stickToBottom
  } = useWorkScroll({ messages: state.messages, userMessages })

  /** 会话管理：拉历史/列表、切换/新建/改名/删除（2026-10-26 抽到 useWorkConversations） */
  const {
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
  } = useWorkConversations({
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
  })

  /** 发送与打断（2026-10-26 抽到 useWorkSend） */
  const { handleSend, handleInterrupt } = useWorkSend({
    search,
    streamingIdsRef,
    activeConversationRef,
    dispatch,
    stickToBottom
  })
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
      // 启动默认打开「宠物会话」（2026-10-27）：宠物窗固定复用 pet-primary，
      // 普通对话是用户手动新建/切换才进入，不再让上次的临时会话抢默认入口。
      const petSession = items?.find((item) => item.kind === 'pet')
      const fallbackId = petSession?.id ?? items?.[0]?.id ?? null
      const id =
        petSession?.id ??
        (inList
          ? (saved as string)
          : (fallbackId ??
            (items === null ? saved : null) ??
            globalThis.crypto?.randomUUID?.() ??
            `c_${Date.now().toString(36)}`))
      activateConversation(id)
      dispatch({ type: 'reset' })
      await requestHistory(id)
    }
    void boot()

    return () => {
      offEvent()
      offPetReady()
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
            onDeleteMany={(ids) => void deleteConversations(ids)}
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
              onLocateHistory={locateHistoryItem}
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
