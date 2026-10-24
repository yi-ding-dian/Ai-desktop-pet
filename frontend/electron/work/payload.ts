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
        .map((item) =>
          typeof item === 'object' && item !== null
            ? {
                path: typeof (item as Record<string, unknown>).path === 'string'
                  ? ((item as Record<string, unknown>).path as string)
                  : '',
                name: typeof (item as Record<string, unknown>).name === 'string'
                  ? ((item as Record<string, unknown>).name as string)
                  : ''
              }
            : null
        )
        .filter((item): item is { path: string; name: string } => item !== null && item.path.length > 0)
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
    }
  }
}

export function normalizeHistoryPayload(raw: unknown): WorkHistoryRequestPayload | null {
  if (typeof raw !== 'object' || raw === null) return null
  const value = raw as Record<string, unknown>
  if (typeof value.requestId !== 'string' || value.requestId.length === 0) return null
  const limit =
    typeof value.limit === 'number' && Number.isFinite(value.limit)
      ? Math.max(1, Math.min(500, Math.trunc(value.limit)))
      : 200
  return { requestId: value.requestId, limit }
}
