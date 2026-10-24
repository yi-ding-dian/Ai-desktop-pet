/** 助手消息：思考块 + Markdown 正文 + 引用链接悬浮卡片 + 时间/操作。 */
import type { MouseEvent as ReactMouseEvent, ReactElement } from 'react'
import { renderMarkdownWithCitations } from '../../board/markdown'
import ThinkingBlock from '../ThinkingBlock'
import type { WorkMessage } from '../store'
import LinkPreviewCard from './LinkPreviewCard'
import MessageMeta from './MessageMeta'
import { useLinkHover } from './useLinkHover'
import type { MessageActionProps } from './types'

export default function AssistantMessage({
  message,
  onLinkClick,
  ...actions
}: MessageActionProps & {
  message: WorkMessage
  onLinkClick?: (event: ReactMouseEvent<HTMLDivElement>) => void
}): ReactElement {
  // 悬浮卡片逻辑与任务模式共用（useLinkHover，2026-10-24）
  const linkHover = useLinkHover(message.sources, message.text)

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
            linkHover.clear()
            onLinkClick?.(event)
          }}
          onMouseOver={linkHover.onMouseOver}
          onMouseOut={linkHover.onMouseOut}
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
      {linkHover.preview !== null ? (
        <LinkPreviewCard
          key={linkHover.preview.url}
          preview={linkHover.preview}
          onMeasure={linkHover.onMeasure}
        />
      ) : null}
    </div>
  )
}
