/** 助手消息：思考块 + Markdown 正文 + 引用链接悬浮卡片 + 时间/操作。 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactElement
} from 'react'
import { renderMarkdownWithCitations } from '../../board/markdown'
import ThinkingBlock from '../ThinkingBlock'
import type { WorkMessage } from '../store'
import LinkPreviewCard, { type LinkPreviewState } from './LinkPreviewCard'
import MessageMeta from './MessageMeta'
import { fallbackSource, hostOf, normalizeUrl, prettyDate } from './format'
import type { MessageActionProps } from './types'

export default function AssistantMessage({
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
