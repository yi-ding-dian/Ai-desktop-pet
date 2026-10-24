/** 引用/来源链接的悬浮卡片：站点 | 日期、标题、摘要（2026-10-19 用户定稿：不显示 URL 行）。 */
import { useLayoutEffect, useRef, useState, type ReactElement } from 'react'
import { hostOf } from './format'

export interface LinkPreviewState {
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

export default function LinkPreviewCard({
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
