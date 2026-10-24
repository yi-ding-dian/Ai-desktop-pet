/** 教学模式的入站参数规范化（渲染面传来的东西一律当作不可信）。 */
import type { TeachingEnterReason, TeachingSendRequestPayload } from '../ipc/channels'

/** 校验进入来源（白名单外退回 'keyword'，仅日志意义） */
export function normalizeEnterReason(reason: unknown): TeachingEnterReason {
  return reason === 'menu' || reason === 'keyword' || reason === 'debug'
    ? reason
    : 'keyword'
}

/**
 * 规范化黑板发送载荷：兼容旧版纯字符串 text；附件只保留 path/name 且最多 3 条
 * （与 files.max_per_turn 一致，后端仍会二次校验）。文本与附件都空则丢弃。
 */
export function normalizeSendPayload(raw: unknown): TeachingSendRequestPayload | null {
  const value = typeof raw === 'string' ? { text: raw } : raw
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  const text = typeof record.text === 'string' ? record.text : ''
  const attachments = Array.isArray(record.attachments)
    ? record.attachments
        .slice(0, 3)
        .map((item) => {
          if (typeof item !== 'object' || item === null) return null
          const entry = item as Record<string, unknown>
          const path = typeof entry.path === 'string' ? entry.path : ''
          const name = typeof entry.name === 'string' ? entry.name : ''
          return path.length > 0 ? { path, name } : null
        })
        .filter((item): item is { path: string; name: string } => item !== null)
    : []
  if (text.trim().length === 0 && attachments.length === 0) return null
  return { text, attachments }
}
