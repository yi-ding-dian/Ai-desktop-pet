/** 时间常显；复制/删除按钮由 CSS 在消息悬浮时显现。 */
import type { ReactElement } from 'react'
import type { WorkMessage } from '../store'
import { formatMessageTime } from './format'

export default function MessageMeta({
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
