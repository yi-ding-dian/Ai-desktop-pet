/** 用户消息：气泡 + 时间/操作。 */
import type { ReactElement } from 'react'
import type { WorkMessage } from '../store'
import MessageMeta from './MessageMeta'
import type { MessageActionProps } from './types'

export default function UserMessage({
  message,
  flash,
  setRef,
  ...actions
}: MessageActionProps & {
  message: WorkMessage
  flash: boolean
  setRef: (node: HTMLDivElement | null) => void
}): ReactElement {
  return (
    <div
      className={`work-msg work-msg-user${flash ? ' work-flash' : ''}`}
      data-key={message.id}
      ref={setRef}
      onContextMenu={(event) => actions.onContextMenu(event, message)}
    >
      <div className="work-user-bubble">{message.text}</div>
      <MessageMeta
        message={message}
        align="end"
        copied={actions.copied}
        onCopy={actions.onCopy}
        onDelete={actions.onDelete}
      />
    </div>
  )
}
