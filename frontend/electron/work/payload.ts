/** 工作窗入站参数校验：渲染面传来的东西一律当作不可信。 */
import type {
  WorkHistoryRequestPayload,
  WorkSendRequestPayload
} from '../ipc/channels'

export function normalizeSendPayload(raw: unknown): WorkSendRequestPayload | null {
  if (typeof raw !== 'object' || raw === null) return null
  const value = raw as Record<string, unknown>
  if (typeof value.requestId !== 'string' || value.requestId.length === 0) return null
  if (typeof value.text !== 'string') return null
  const attachments = Array.isArray(value.attachments)
    ? value.attachments
        .map((item) => {
          if (typeof item !== 'object' || item === null) return null
          const entry = item as Record<string, unknown>
          const path = typeof entry.path === 'string' ? entry.path : ''
          const ref = typeof entry.ref === 'string' ? entry.ref.trim().slice(0, 80) : ''
          return {
            path,
            name: typeof entry.name === 'string' ? entry.name : '',
            ...(ref ? { ref } : {})
          }
        })
        .filter(
          (item): item is { path: string; name: string; ref?: string } =>
            item !== null && item.path.length > 0
        )
    : []
  const optionsRaw =
    typeof value.options === 'object' && value.options !== null
      ? (value.options as Record<string, unknown>)
      : {}
  return {
    requestId: value.requestId,
    text: value.text,
    attachments,
    options: {
      search: optionsRaw.search !== false
    },
    sessionId: normalizeSessionId(value.sessionId)
  }
}

/** 对话 id：只接受 1–64 位字母数字/下划线/连字符（UUID 也满足）。 */
function normalizeSessionId(raw: unknown): string | undefined {
  return typeof raw === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(raw) ? raw : undefined
}

export function normalizeHistoryPayload(raw: unknown): WorkHistoryRequestPayload | null {
  if (typeof raw !== 'object' || raw === null) return null
  const value = raw as Record<string, unknown>
  if (typeof value.requestId !== 'string' || value.requestId.length === 0) return null
  const limit =
    typeof value.limit === 'number' && Number.isFinite(value.limit)
      ? Math.max(1, Math.min(500, Math.trunc(value.limit)))
      : 200
  return {
    requestId: value.requestId,
    limit,
    sessionId: normalizeSessionId(value.sessionId)
  }
}
