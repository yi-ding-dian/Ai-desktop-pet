/**
 * 聊天区一次性提示（chat 域）：展示不进历史、不参与 TTS 的短提示。
 *
 * 首个使用场景是文件分析 P1 的 `context_reset`：为装下当前文件，后端丢弃了
 * 本轮之前的内存上下文。提示显示在输入框上方，自动消失；不弹气泡、不打断对话。
 */
export interface ChatNotice {
  id: number
  text: string
  kind: 'info' | 'warn' | 'error'
}

type Listener = (notice: ChatNotice | null) => void

let seq = 0
let current: ChatNotice | null = null
let timer: number | null = null
const listeners = new Set<Listener>()

function emit(): void {
  for (const listener of [...listeners]) {
    try {
      listener(current)
    } catch (err) {
      console.error('[chat] notice 订阅者抛错：', err)
    }
  }
}

function clearTimer(): void {
  if (timer !== null) {
    window.clearTimeout(timer)
    timer = null
  }
}

/** 显示一条提示（覆盖上一条；默认 8s 后自动消失）。 */
export function showChatNotice(
  text: string,
  kind: ChatNotice['kind'] = 'info',
  ttlMs = 8_000
): void {
  const trimmed = text.trim()
  if (!trimmed) return
  clearTimer()
  current = { id: ++seq, text: trimmed, kind }
  emit()
  timer = window.setTimeout(() => {
    timer = null
    current = null
    emit()
  }, ttlMs)
}

/** 手动清除（发送新消息/退出教学等场景可选调用）。 */
export function clearChatNotice(): void {
  clearTimer()
  if (current === null) return
  current = null
  emit()
}

/** 订阅当前提示（返回取消订阅函数）；订阅时立即回放当前值。 */
export function subscribeChatNotice(listener: Listener): () => void {
  listeners.add(listener)
  listener(current)
  return () => {
    listeners.delete(listener)
  }
}
