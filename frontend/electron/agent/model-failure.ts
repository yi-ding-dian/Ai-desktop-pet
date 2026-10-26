/**
 * 模型请求失败检测（2026-10-26）。
 *
 * pi-agent 遇到 API/鉴权失败时不抛异常，而是把 assistant 消息标记为
 * `stopReason: 'error'` 并带上 `errorMessage` 正常返回。主进程若不检查，
 * 任务会被误标成「已完成」，界面上完全看不出失败（DeepSeek 401 即此情况）。
 */

interface ModelMessage {
  role?: string
  stopReason?: string
  errorMessage?: string
}

/** 只看最后一条 assistant：返回失败原因；成功或无 assistant 消息返回 null。 */
export function lastAssistantFailure(messages: readonly unknown[]): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as ModelMessage | null
    if (message?.role !== 'assistant') continue
    if (message.stopReason !== 'error') return null
    const text = (message.errorMessage ?? '').trim()
    return text || '模型请求失败（未返回原因）'
  }
  return null
}
