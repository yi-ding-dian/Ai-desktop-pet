/** 任务流里的本地路径悬浮预览（网页链接走 useLinkHover 的来源卡片，与对话模式一致）。 */
import type { ReactElement } from 'react'

export interface HoverCardState {
  kind: 'path'
  text: string
  x: number
  y: number
}

export default function HoverCard({
  card
}: {
  card: HoverCardState | null
}): ReactElement | null {
  if (!card) return null
  return (
    <div
      className={`task-preview task-preview-${card.kind}`}
      style={{
        left: Math.max(8, Math.min(card.x, window.innerWidth - 340)),
        top: Math.max(8, card.y - 8)
      }}
    >
      <div className="task-preview-url">{card.text}</div>
      <div className="task-preview-hint">点击用默认程序打开</div>
    </div>
  )
}
