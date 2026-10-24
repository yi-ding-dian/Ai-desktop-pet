/**
 * 引用/来源链接的悬浮卡片（2026-10-24 从 AssistantMessage 抽出）。
 *
 * 对话模式与任务模式共用同一套行为：悬停 220ms 后展示站点/日期/标题/摘要；
 * 默认向上，渲染后按实际高度翻到向下；滚动时收起。
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent
} from 'react'
import type { LinkPreviewState } from './LinkPreviewCard'
import { fallbackSource, hostOf, normalizeUrl, prettyDate } from './format'

/** 与后端 sources / AgentSourceItem 同构（任务模式也直接传这个结构） */
export interface HoverSource {
  url: string
  title?: string
  snippet?: string
  site_name?: string
  date?: string
}

export interface LinkHover {
  preview: LinkPreviewState | null
  onMouseOver: (event: ReactMouseEvent<HTMLElement>) => void
  onMouseOut: (event: ReactMouseEvent<HTMLElement>) => void
  /** 卡片渲染后回报实际高度（放不下时翻到向下） */
  onMeasure: (height: number) => void
  clear: () => void
}

const HOVER_DELAY_MS = 220
/** 与 work.css 的 .work-link-preview width 保持一致（左右各留 8px） */
const CARD_WIDTH = 360

export function useLinkHover(
  sources: HoverSource[] | undefined,
  /** 正文：没有结构化来源时从"来源"行里兜底抠标题/日期 */
  text: string | undefined
): LinkHover {
  const [preview, setPreview] = useState<LinkPreviewState | null>(null)
  const hoverTimer = useRef<number | null>(null)

  const clearTimer = useCallback((): void => {
    if (hoverTimer.current !== null) {
      window.clearTimeout(hoverTimer.current)
      hoverTimer.current = null
    }
  }, [])

  useEffect(() => () => clearTimer(), [clearTimer])

  // 悬浮卡片按固定定位锚在链接旁；滚动后位置会失效，直接收起
  useEffect(() => {
    if (preview === null) return
    const hide = (): void => setPreview(null)
    document.addEventListener('scroll', hide, true)
    return () => document.removeEventListener('scroll', hide, true)
  }, [preview])

  const onMouseOver = useCallback(
    (event: ReactMouseEvent<HTMLElement>): void => {
      const target = event.target as HTMLElement
      const anchor = target.closest('a')
      if (anchor === null) return
      const url = anchor.href
      if (!/^https?:\/\//i.test(url)) return
      clearTimer()
      const rect = anchor.getBoundingClientRect()
      hoverTimer.current = window.setTimeout(() => {
        hoverTimer.current = null
        const source = sources?.find(
          (item) => normalizeUrl(item.url) === normalizeUrl(url)
        )
        const fallback = text ? fallbackSource(text, url) : null
        const left = Math.min(
          Math.max(8, rect.left + rect.width / 2 - CARD_WIDTH / 2),
          window.innerWidth - CARD_WIDTH - 8
        )
        // 默认向上：向下会挡住"接下来要读的正文"；渲染后测高，放不下再翻到向下
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
          above: true
        })
      }, HOVER_DELAY_MS)
    },
    [clearTimer, sources, text]
  )

  const onMouseOut = useCallback(
    (event: ReactMouseEvent<HTMLElement>): void => {
      const target = event.target as HTMLElement
      const anchor = target.closest('a')
      const related = event.relatedTarget
      if (anchor !== null && related instanceof Node && anchor.contains(related)) {
        return
      }
      clearTimer()
      setPreview(null)
    },
    [clearTimer]
  )

  /** 卡片渲染后按实际高度确认：默认向上，仅当上方放不下（高度 + 8px 间距）时翻到向下 */
  const onMeasure = useCallback((height: number): void => {
    setPreview((prev) => {
      if (prev === null || !prev.above || prev.anchorTop >= height + 8) return prev
      return { ...prev, above: false }
    })
  }, [])

  const clear = useCallback((): void => {
    clearTimer()
    setPreview(null)
  }, [clearTimer])

  return { preview, onMouseOver, onMouseOut, onMeasure, clear }
}
