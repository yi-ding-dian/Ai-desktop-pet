/** 消息列表：空态 + 按角色分发到用户/助手消息。 */
import type { MouseEvent as ReactMouseEvent, ReactElement } from 'react'
import { EmptyState } from '../../shared/ui'
import type { WorkMessage } from '../store'
import AssistantMessage from './AssistantMessage'
import UserMessage from './UserMessage'

export interface MessageListProps {
  messages: WorkMessage[]
  flashId: string | null
  copiedId: string | null
  setMessageRef: (id: string) => (node: HTMLDivElement | null) => void
  onCopy: (message: WorkMessage) => void
  onDelete: (message: WorkMessage) => void
  onContextMenu: (event: ReactMouseEvent, message: WorkMessage) => void
  onLinkClick: (event: ReactMouseEvent<HTMLDivElement>) => void
}

export default function MessageList({
  messages,
  flashId,
  copiedId,
  setMessageRef,
  onCopy,
  onDelete,
  onContextMenu,
  onLinkClick
}: MessageListProps): ReactElement {
  if (messages.length === 0) {
    return (
      <EmptyState
        fill
        icon="✦"
        title="开始一段认真的对话"
        hint="完整记录、历史导航，长回答也能慢慢看"
      />
    )
  }
  return (
    <div className="work-messages">
      {messages.map((message) =>
        message.role === 'user' ? (
          <UserMessage
            key={message.id}
            message={message}
            flash={flashId === message.id}
            setRef={setMessageRef(message.id)}
            copied={copiedId === message.id}
            onCopy={onCopy}
            onDelete={onDelete}
            onContextMenu={onContextMenu}
          />
        ) : (
          <AssistantMessage
            key={message.id}
            message={message}
            copied={copiedId === message.id}
            onCopy={onCopy}
            onDelete={onDelete}
            onContextMenu={onContextMenu}
            onLinkClick={onLinkClick}
          />
        )
      )}
    </div>
  )
}
