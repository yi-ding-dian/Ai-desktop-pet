/**
 * 对话消息操作（2026-10-26 从 WorkApp 抽出）。
 *
 * 负责：复制整条/选中文本、删除消息、右键菜单状态与关闭时机、复制成功短暂高亮。
 */
import { useCallback, useEffect, useState, type MouseEvent as ReactMouseEvent } from 'react'
import type { ContextMenuState } from '../MessageContextMenu'
import { copyTextToClipboard } from '../format'
import type { WorkMessage } from '../../store'
import { workBridge } from '../../work-bridge'

/** 复制成功的对勾持续多久 */
const COPIED_HIGHLIGHT_MS = 1500

export interface WorkMessagesOptions {
  /** 当前前台会话 id（删除消息时带上，避免跨会话误删） */
  activeConversationRef: React.MutableRefObject<string>
}

export interface WorkMessagesControls {
  copiedId: string | null
  contextMenu: ContextMenuState | null
  setContextMenu: React.Dispatch<React.SetStateAction<ContextMenuState | null>>
  markCopied: (id: string) => void
  copyMessage: (message: WorkMessage) => Promise<void>
  copySelection: (message: WorkMessage, selection: string) => Promise<void>
  deleteMessage: (message: WorkMessage) => void
  openContextMenu: (event: ReactMouseEvent, message: WorkMessage) => void
}

export function useWorkMessages({
  activeConversationRef
}: WorkMessagesOptions): WorkMessagesControls {
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)

  const markCopied = useCallback((id: string): void => {
    setCopiedId(id)
    window.setTimeout(
      () => setCopiedId((current) => (current === id ? null : current)),
      COPIED_HIGHLIGHT_MS
    )
  }, [])

  /** 复制整条：助手复制 Markdown 源文，用户复制纯文本 */
  const copyMessage = useCallback(
    async (message: WorkMessage): Promise<void> => {
      if (await copyTextToClipboard(message.text)) markCopied(message.id)
    },
    [markCopied]
  )

  /** 复制选中文本（右键时捕获，避免菜单点击后选区丢失） */
  const copySelection = useCallback(
    async (message: WorkMessage, selection: string): Promise<void> => {
      if (await copyTextToClipboard(selection)) markCopied(message.id)
    },
    [markCopied]
  )

  const deleteMessage = useCallback(
    (message: WorkMessage): void => {
      if (message.dbId === undefined) return
      workBridge()?.deleteMessage?.({
        dbId: message.dbId,
        sessionId: activeConversationRef.current || undefined
      })
    },
    [activeConversationRef]
  )

  const openContextMenu = useCallback(
    (event: ReactMouseEvent, message: WorkMessage): void => {
      event.preventDefault()
      const selection = window.getSelection()?.toString() ?? ''
      setContextMenu({
        x: event.clientX,
        y: event.clientY,
        messageId: message.id,
        selection
      })
    },
    []
  )

  // 右键菜单：点击空白 / Esc / 滚动即关闭
  useEffect(() => {
    if (contextMenu === null) return
    const close = (): void => setContextMenu(null)
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') close()
    }
    document.addEventListener('pointerdown', close)
    document.addEventListener('keydown', onKeyDown)
    window.addEventListener('scroll', close, true)
    return () => {
      document.removeEventListener('pointerdown', close)
      document.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('scroll', close, true)
    }
  }, [contextMenu])

  return {
    copiedId,
    contextMenu,
    setContextMenu,
    markCopied,
    copyMessage,
    copySelection,
    deleteMessage,
    openContextMenu
  }
}
