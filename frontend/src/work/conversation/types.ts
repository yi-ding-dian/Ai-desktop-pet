import type { MouseEvent as ReactMouseEvent } from 'react'
import type { WorkMessage } from '../store'

/** 消息列表里每一条都需要的一组操作（复制/删除/右键）。 */
export interface MessageActionProps {
  copied: boolean
  onCopy: (message: WorkMessage) => void
  onDelete: (message: WorkMessage) => void
  onContextMenu: (event: ReactMouseEvent, message: WorkMessage) => void
}
