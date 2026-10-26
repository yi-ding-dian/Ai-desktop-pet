/**
 * 任务消息流交互（2026-10-26 从 TaskPanel 抽出）。
 *
 * 负责：滚动跟随与「回到底部」、步骤展开、复制高亮、链接/路径悬浮卡片、
 * 点击路径打开、历史条目定位高亮。
 */
import { useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import { getPetBridge } from '../../shared/pet-bridge'
import { looksLikeAbsolutePath } from '../../modules/chat/file-support'
import type { AgentStep } from '../../../electron/ipc/channels'
import type { ComposerHistoryItem } from '../input/chat-history'
import { copyText } from '../shared/clipboard'
import { useLinkHover } from '../conversation/useLinkHover'
import type { HoverCardState } from './agent-flow/HoverCard'

type LinkHoverControls = ReturnType<typeof useLinkHover>

export interface TaskFlowOptions {
  /** 引用/来源链接卡片（与对话模式共用） */
  linkHover: LinkHoverControls
  /** 页面提示（例如历史条目已不在视图里） */
  onNotice: (message: string | null) => void
}

export interface TaskFlowControls {
  scrollRef: React.MutableRefObject<HTMLDivElement | null>
  /** 是否跟随到底（滚动到接近底部时为 true） */
  stickRef: React.MutableRefObject<boolean>
  showJump: boolean
  flashId: string | null
  copiedId: string | null
  expanded: Record<string, boolean>
  hoverCard: HoverCardState | null
  clearHoverCard: () => void
  markCopied: (id: string) => void
  handleCopyStep: (id: string, text: string) => void
  handleFlowHover: (event: ReactMouseEvent<HTMLDivElement>) => void
  handleFlowOut: (event: ReactMouseEvent<HTMLDivElement>) => void
  handleFlowClick: (event: ReactMouseEvent<HTMLDivElement>) => void
  handleScroll: () => void
  jumpToBottom: () => void
  locateHistoryItem: (item: ComposerHistoryItem) => void
  toggleExpanded: (step: AgentStep) => void
  /** 切换任务时清掉定位高亮 */
  resetHighlight: () => void
}

export function useTaskFlow({
  linkHover,
  onNotice
}: TaskFlowOptions): TaskFlowControls {
  const [showJump, setShowJump] = useState(false)
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const [hoverCard, setHoverCard] = useState<HoverCardState | null>(null)
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [flashId, setFlashId] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const stickRef = useRef(true)
  const flashTimerRef = useRef<number | null>(null)

  const markCopied = useCallback((id: string): void => {
    setCopiedId(id)
    window.setTimeout(() => setCopiedId((current) => (current === id ? null : current)), 1500)
  }, [])

  const handleCopyStep = useCallback(
    (id: string, text: string): void => {
      copyText(text)
      markCopied(id)
    },
    [markCopied]
  )

  const handleFlowHover = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>): void => {
      const target = event.target as HTMLElement
      const link = target.closest('a')
      if (link) {
        const href = link.getAttribute('href') ?? ''
        if (href.startsWith('http://') || href.startsWith('https://')) {
          // 与对话模式同一套卡片（站点/日期/标题/摘要）
          linkHover.onMouseOver(event)
          return
        }
      }
      const code = target.closest('code')
      if (code) {
        const text = (code.textContent ?? '').trim()
        if (looksLikeAbsolutePath(text)) {
          const rect = code.getBoundingClientRect()
          setHoverCard({ kind: 'path', text, x: rect.left, y: rect.top })
          return
        }
      }
      setHoverCard(null)
    },
    [linkHover]
  )

  /** 离开链接时收起卡片（与对话模式同一套判定：指针是否仍在同一个 a 内） */
  const handleFlowOut = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>): void => {
      linkHover.onMouseOut(event)
    },
    [linkHover]
  )

  const handleFlowClick = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>): void => {
      linkHover.clear()
      const target = event.target as HTMLElement
      if (target.closest('a')) return
      const code = target.closest('code')
      if (!code) return
      const text = (code.textContent ?? '').trim()
      if (!looksLikeAbsolutePath(text)) return
      event.preventDefault()
      try {
        void getPetBridge().system.openPath(text)
      } catch {
        /* 旧 preload：静默降级 */
      }
    },
    [linkHover]
  )

  const handleScroll = useCallback((): void => {
    const el = scrollRef.current
    if (!el) return
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 56
    stickRef.current = near
    setShowJump(!near)
  }, [])

  const jumpToBottom = useCallback((): void => {
    const el = scrollRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
    stickRef.current = true
    setShowJump(false)
  }, [])

  // 卸载：清掉高亮定时器
  useEffect(() => {
    return () => {
      if (flashTimerRef.current !== null) window.clearTimeout(flashTimerRef.current)
    }
  }, [])

  const resetHighlight = useCallback((): void => {
    setFlashId(null)
    if (flashTimerRef.current !== null) {
      window.clearTimeout(flashTimerRef.current)
      flashTimerRef.current = null
    }
  }, [])

  /** 历史条目的时间点击：滚到消息流里的原文并短暂高亮；同时暂停自动跟到底 */
  const locateHistoryItem = useCallback(
    (item: ComposerHistoryItem): void => {
      const scroller = scrollRef.current
      if (!scroller) return
      const target = scroller.querySelector<HTMLElement>(
        `[data-step-id="${CSS.escape(item.id)}"]`
      )
      if (!target) {
        onNotice('这条消息太久了，已不在当前视图里')
        window.setTimeout(() => onNotice(null), 3_000)
        return
      }
      onNotice(null)
      stickRef.current = false
      setShowJump(true)
      target.scrollIntoView({ block: 'center', behavior: 'smooth' })
      setFlashId(item.id)
      if (flashTimerRef.current !== null) window.clearTimeout(flashTimerRef.current)
      flashTimerRef.current = window.setTimeout(() => {
        setFlashId(null)
        flashTimerRef.current = null
      }, 1_300)
    },
    [onNotice]
  )

  const clearHoverCard = useCallback((): void => setHoverCard(null), [])

  const toggleExpanded = useCallback((step: AgentStep): void => {    setExpanded((current) => {
      const fallback = step.kind === 'thinking' && step.status === 'running'
      const wasOpen = current[step.id] ?? fallback
      return { ...current, [step.id]: !wasOpen }
    })
  }, [])

  return {
    scrollRef,
    stickRef,
    showJump,
    flashId,
    copiedId,
    expanded,
    hoverCard,
    clearHoverCard,
    markCopied,
    handleCopyStep,
    handleFlowHover,
    handleFlowOut,
    handleFlowClick,
    handleScroll,
    jumpToBottom,
    locateHistoryItem,
    toggleExpanded,
    resetHighlight
  }
}
