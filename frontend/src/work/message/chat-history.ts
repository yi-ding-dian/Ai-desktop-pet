/**
 * 输入框「已发送消息」历史（2026-10-25）。
 *
 * 两页共用：任务模式从 round 步骤派生（task/history.ts），对话模式从当前会话的
 * user 消息派生（本文件）。只收用户消息，助手回复不进历史；顺序按消息顺序，
 * 最旧在前、最新在后。
 */
import type { WorkMessage } from '../store'

export interface ComposerHistoryItem {
  /** 定位锚点：用户消息 id（对话模式）或 round 步骤 id（任务模式） */
  id: string
  /** 用户原话（保留原样；展示时再截断） */
  text: string
  /** 发送时间（ms）；旧记录可能缺失 */
  at: number | null
}

/** 当前会话的已发送用户消息；空文本忽略（只带附件的消息由后端补默认问题）。 */
export function buildChatHistory(messages: WorkMessage[]): ComposerHistoryItem[] {
  const items: ComposerHistoryItem[] = []
  for (const message of messages) {
    if (message.role !== 'user') continue
    if ((message.text ?? '').trim().length === 0) continue
    items.push({
      id: message.id,
      text: message.text,
      at: Number.isFinite(message.createdAt) ? message.createdAt : null
    })
  }
  return items
}
