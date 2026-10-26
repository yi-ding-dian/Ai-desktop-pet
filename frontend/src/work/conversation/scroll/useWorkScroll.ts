/**
 * 工作窗对话滚动与导航（2026-10-26 从 WorkApp 抽出）。
 *
 * 负责：测量内容高度与导航锚点、滚动跟随底部、跳转到指定消息并短暂高亮、
 * 历史条目定位。消息元素的 ref 也由这里管理（MessageList 通过 setMessageRef 挂载）。
 */
import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState
} from 'react'
import type { NavigatorAnchor } from '../../navigator'
import type { ComposerHistoryItem } from '../../input/chat-history'
import type { WorkMessage } from '../../store'

/** 距底部多近算「跟随中」 */
const NEAR_BOTTOM_GAP = 80
/** 定位高亮持续时间 */
const FLASH_MS = 700

export interface WorkScrollOptions {
  messages: WorkMessage[]
  /** 导航用的消息（只收用户消息，见 navigatorMessages） */
  userMessages: WorkMessage[]
}

export interface WorkScrollControls {
  scrollRef: React.MutableRefObject<HTMLDivElement | null>
  messageRefs: React.MutableRefObject<Map<string, HTMLElement>>
  scrollTop: number
  anchors: NavigatorAnchor[]
  contentHeight: number
  viewportHeight: number
  flashId: string | null
  measure: () => void
  handleScroll: () => void
  scrollToMessage: (id: string, block?: ScrollLogicalPosition) => void
  handleJump: (id: string) => void
  locateHistoryItem: (item: ComposerHistoryItem) => void
  /** 发送消息 / 切换会话后恢复「跟随底部」 */
  stickToBottom: () => void
}

export function useWorkScroll({
  messages,
  userMessages
}: WorkScrollOptions): WorkScrollControls {
  const scrollRef = useRef<HTMLDivElement>(null)
  const messageRefs = useRef(new Map<string, HTMLElement>())
  const nearBottom = useRef(true)
  const metricsKey = useRef('')

  const [scrollTop, setScrollTop] = useState(0)
  const [anchors, setAnchors] = useState<NavigatorAnchor[]>([])
  const [contentHeight, setContentHeight] = useState(0)
  const [viewportHeight, setViewportHeight] = useState(0)
  const [flashId, setFlashId] = useState<string | null>(null)

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
    const key = `${top}|${height}|${viewport}|${nextAnchors
      .map((anchor) => `${anchor.id}:${Math.round(anchor.offsetTop)}`)
      .join(',')}`
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
  }, [messages, measure])

  // 新消息：用户停在底部附近时自动跟随
  useLayoutEffect(() => {
    const element = scrollRef.current
    if (element === null) return
    if (!nearBottom.current) return
    element.scrollTop = element.scrollHeight
  }, [messages])

  const handleScroll = useCallback((): void => {
    const element = scrollRef.current
    if (element === null) return
    nearBottom.current =
      element.scrollHeight - element.scrollTop - element.clientHeight < NEAR_BOTTOM_GAP
    measure()
  }, [measure])

  const stickToBottom = useCallback((): void => {
    nearBottom.current = true
  }, [])

  const scrollToMessage = useCallback(
    (id: string, block: ScrollLogicalPosition = 'start'): void => {
      const node = messageRefs.current.get(id)
      if (node === undefined) return
      node.scrollIntoView({ behavior: 'smooth', block })
      setFlashId(id)
      window.setTimeout(
        () => setFlashId((current) => (current === id ? null : current)),
        FLASH_MS
      )
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
  const locateHistoryItem = useCallback(
    (item: ComposerHistoryItem): void => {
      scrollToMessage(item.id, 'center')
    },
    [scrollToMessage]
  )

  return {
    scrollRef,
    messageRefs,
    scrollTop,
    anchors,
    contentHeight,
    viewportHeight,
    flashId,
    measure,
    handleScroll,
    scrollToMessage,
    handleJump,
    locateHistoryItem,
    stickToBottom
  }
}
