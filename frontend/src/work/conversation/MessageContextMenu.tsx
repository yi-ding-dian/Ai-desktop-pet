/** 消息右键菜单：复制全文 / 复制选中 / 删除。 */
import type { ReactElement } from 'react'
import type { WorkMessage } from '../store'

export interface ContextMenuState {
  x: number
  y: number
  messageId: string
  selection: string
}

export default function MessageContextMenu({
  menu,
  message,
  onCopy,
  onCopySelection,
  onDelete
}: {
  menu: ContextMenuState | null
  message: WorkMessage | undefined
  onCopy: (message: WorkMessage) => void
  onCopySelection: (message: WorkMessage, selection: string) => void
  onDelete: (message: WorkMessage) => void
}): ReactElement | null {
  if (menu === null || message === undefined) return null
  const left = Math.min(menu.x, Math.max(8, window.innerWidth - 180))
  const top = Math.min(menu.y, Math.max(8, window.innerHeight - 150))
  return (
    <div
      className="work-context-menu"
      style={{ left, top }}
      role="menu"
      onPointerDown={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.preventDefault()}
    >
      <button
        type="button"
        className="work-context-item"
        role="menuitem"
        onClick={() => void onCopy(message)}
      >
        复制全文
      </button>
      <button
        type="button"
        className="work-context-item"
        role="menuitem"
        disabled={menu.selection.trim().length === 0}
        onClick={() => void onCopySelection(message, menu.selection)}
      >
        复制选中
      </button>
      <div className="work-context-sep" role="separator" />
      <button
        type="button"
        className="work-context-item work-context-item-danger"
        role="menuitem"
        disabled={message.dbId === undefined || message.status === 'streaming'}
        title={
          message.status === 'streaming'
            ? '回复完成后才能删除'
            : message.dbId === undefined
              ? '这条消息还没落库，稍后再删'
              : undefined
        }
        onClick={() => onDelete(message)}
      >
        删除此消息
      </button>
    </div>
  )
}
