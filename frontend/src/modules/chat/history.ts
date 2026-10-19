/**
 * 会话记录（chat 域）：本次会话的问答记录（user + assistant 成对），内存会话级。
 *
 * 说话气泡「展开」已改为打开工作模式窗（工作窗经 WS `load_history` 自己拉后端历史），
 * 本模块不再参与展开链路；保留记录能力，作为"清空聊天"（预留）与后续会话视图的数据源。
 *
 * 记录点：
 *  - user：teaching 域的"已发送"广播（统一发送入口 sendUserMessage 成功送出后通知——聊天输入框
 *    与黑板输入条两条路径都能记录到，不重复挂钩发送点）；
 *  - assistant：本域订阅 WS reply_end（full_text 权威终稿；message_id 作记录 id——与黑板
 *    goto 映射/教学镜像的 messageId 语义一致）。
 *
 * 内存会话级（重启清空——"刚刚的"字面语义）；上限 MAX_RECORDS 条（防长会话内存膨胀，丢最旧）。
 */
import type { WsClient } from '../../shared/ws-client'
import { subscribeSentUserMessages } from '../teaching'

/** 一条会话记录（role 与黑板 history 契约一致；id：user=本地生成 / assistant=reply 的 message_id） */
export interface ChatRecord {
  id: string
  role: 'user' | 'assistant'
  text: string
}

/** 记录上限（条；超出丢最旧——白板是"刚刚的"记录，不是全量归档） */
const MAX_RECORDS = 200

let records: ChatRecord[] = []
let seq = 0

function makeLocalId(): string {
  const uuid = globalThis.crypto?.randomUUID?.()
  return uuid ?? `h_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
}

/** 取本次会话记录快照（清空聊天/后续会话视图用；返回副本防外部改动） */
export function getChatHistory(): ChatRecord[] {
  return [...records]
}

/** 清空本次会话记录（右键"清空聊天"的落点，预留——本期清空逻辑仍未实装） */
export function clearChatHistory(): void {
  records = []
}

/**
 * 接线会话记录（App 挂载时调用一次）。返回清理函数。
 * user 记录经 teaching 域统一发送入口广播；assistant 记录订阅 WS reply_end。
 */
export function setupChatHistory(client: WsClient): () => void {
  const offSent = subscribeSentUserMessages((text) => {
    seq += 1
    const item: ChatRecord = { id: `u_${seq}_${makeLocalId()}`, role: 'user', text }
    records = [...records, item].slice(-MAX_RECORDS)
  })
  const offReplyEnd = client.on('reply_end', ({ message_id, full_text }) => {
    if (!full_text.trim()) return
    const item: ChatRecord = { id: message_id, role: 'assistant', text: full_text }
    records = [...records, item].slice(-MAX_RECORDS)
  })
  return () => {
    offSent()
    offReplyEnd()
  }
}
