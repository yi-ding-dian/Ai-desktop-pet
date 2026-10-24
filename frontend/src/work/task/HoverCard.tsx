/** 消息流里的悬浮预览：网页链接 / 图片链接 / 本地路径。 */
import type { ReactElement } from 'react'

export type HoverCardState =
  | { kind: 'link'; href: string; isImage: boolean; x: number; y: number }
  | { kind: 'path'; text: string; x: number; y: number }

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
      {card.kind === 'link' ? (
        <>
          {card.isImage ? (
            <img
              className="task-preview-img"
              src={card.href}
              alt=""
              onError={(event) => {
                event.currentTarget.style.display = 'none'
              }}
            />
          ) : null}
          <div className="task-preview-url">{card.href}</div>
          <div className="task-preview-hint">点击在浏览器打开</div>
        </>
      ) : (
        <>
          <div className="task-preview-url">{card.text}</div>
          <div className="task-preview-hint">点击用默认程序打开</div>
        </>
      )}
    </div>
  )
}
