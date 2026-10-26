/**
 * 任务页右键菜单（2026-10-26 从 TaskPanel 抽出）：
 * 任务行 = 删除任务；选中文字 = 复制；命令块 = 复制命令。
 * 点外面 / Esc 关闭。
 */
import { useEffect, type ReactElement } from 'react'
import { copyText } from '../shared/clipboard'

export type TaskMenu =
  | { kind: 'task'; taskId: string; x: number; y: number }
  | { kind: 'text'; text: string; x: number; y: number }
  | { kind: 'command'; text: string; x: number; y: number }

export interface TaskContextMenuProps {
  menu: TaskMenu
  onClose: () => void
  onDeleteTask: (id: string) => void
}

export default function TaskContextMenu({
  menu,
  onClose,
  onDeleteTask
}: TaskContextMenuProps): ReactElement {
  useEffect(() => {
    const close = (): void => onClose()
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('pointerdown', close)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointerdown', close)
      window.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  return (
    <div
      className="task-menu"
      style={{ left: menu.x, top: menu.y }}
      onPointerDown={(event) => event.stopPropagation()}
    >
      {menu.kind === 'task' ? (
        <button
          type="button"
          className="task-menu-item"
          onClick={() => onDeleteTask(menu.taskId)}
        >
          删除任务
        </button>
      ) : menu.kind === 'command' ? (
        <button
          type="button"
          className="task-menu-item"
          onClick={() => {
            copyText(menu.text)
            onClose()
          }}
        >
          复制命令
        </button>
      ) : (
        <button
          type="button"
          className="task-menu-item"
          onClick={() => {
            copyText(menu.text)
            onClose()
          }}
        >
          复制
        </button>
      )}
    </div>
  )
}
