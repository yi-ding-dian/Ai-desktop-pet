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
  type ReactElement
} from 'react'
import type { PickedFile, WorkMirrorEvent } from '../../electron/ipc/channels'
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
import { renderMarkdownSafe } from '../board/markdown'
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
  const [think, setThink] = useState<boolean>(() => {
    try {
      return localStorage.getItem('work-think') === '1'
    } catch {
      return false
    }
  })
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
    api.ready()
    void requestHistory()
    return () => {
      offEvent()
      offPetReady()
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
      localStorage.setItem('work-think', think ? '1' : '0')
    } catch {
      /* 存储不可用：仅本次生效 */
    }
  }, [think])
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
          options: { think, search }
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
    [search, think]
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
        subtitle={streaming ? '回复中…' : undefined}
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
      />

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
                  />
                ) : (
                  <AssistantMessage key={message.id} message={message} />
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
        think={think}
        search={search}
        onThinkChange={setThink}
        onSearchChange={setSearch}
        onSend={handleSend}
        onStop={handleInterrupt}
        notice={state.notice}
        onDismissNotice={() => dispatch({ type: 'clear-notice' })}
      />
    </WindowFrame>
  )
}

function UserMessage({
  message,
  flash,
  setRef
}: {
  message: WorkMessage
  flash: boolean
  setRef: (node: HTMLDivElement | null) => void
}): ReactElement {
  return (
    <div
      className={`work-msg work-msg-user${flash ? ' work-flash' : ''}`}
      data-key={message.id}
      ref={setRef}
    >
      <div className="work-user-bubble">{message.text}</div>
    </div>
  )
}

function AssistantMessage({ message }: { message: WorkMessage }): ReactElement {
  return (
    <div className="work-msg work-msg-assistant" data-key={message.id}>
      <ThinkingBlock
        reasoning={message.reasoning}
        streaming={message.status === 'streaming'}
        startedAt={message.sentAt}
        thinkingMs={message.thinkingMs}
      />
      {message.text.length > 0 ? (
        <div
          className="md-body work-markdown"
          dangerouslySetInnerHTML={{ __html: renderMarkdownSafe(message.text) }}
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
    </div>
  )
}
