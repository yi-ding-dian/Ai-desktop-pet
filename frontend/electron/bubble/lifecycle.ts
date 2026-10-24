/** 气泡收尾：结清待确认动作、等待退场动画、隐藏并销毁/复用窗口。 */
import { IPC_BUBBLE } from '../ipc/channels'
import { CLOSE_TIMEOUT_MS } from './constants'
import { bubbleState } from './state'
import { destroyBubbleWindow, getBubbleWindow, sendTo } from './window'

/** 退场回报超时定时器 */
let closeTimer: NodeJS.Timeout | null = null
/** 收尾前后的清理钩子（index 注入说话气泡的计时器与恢复逻辑，避免模块循环依赖） */
let beforeClose: () => void = () => {}
let afterClose: () => void = () => {}

export function setCloseHooks(hooks: { before: () => void; after: () => void }): void {
  beforeClose = hooks.before
  afterClose = hooks.after
}

/** 结清当前待确认动作：把结果交还请求方并清掉定时器（幂等）。 */
export function settleConfirm(confirmed: boolean): void {
  const pending = bubbleState.pendingConfirm
  if (!pending) return
  bubbleState.pendingConfirm = null
  if (pending.timer) clearTimeout(pending.timer)
  try {
    pending.resolve(confirmed)
  } catch (err) {
    console.warn('[bubble] 确认结果回传失败（忽略）：', err)
  }
}

/**
 * 气泡收尾（真实隐藏）：清超时定时器 + closing 复位 + hide + 销毁窗口。
 * 供渲染侧 CLOSED 回报、超时兜底、弹出前"半收状态"收尾共用。
 */
export function finishClose(reason: string): void {
  // 确认气泡被关闭（取消/点别处/退场回报）：把 false 交还给请求方
  settleConfirm(false)
  beforeClose()
  if (closeTimer) {
    clearTimeout(closeTimer)
    closeTimer = null
  }
  bubbleState.closing = false
  const win = getBubbleWindow()
  if (win && !win.isDestroyed() && win.isVisible()) {
    win.hide()
    console.log(`[bubble] 气泡窗已隐藏（${reason}）`)
  }
  destroyBubbleWindow(`收尾：${reason}`)
  afterClose()
}

/** 请求收起（blur / 动作执行后）：先让渲染侧播退场动画，CLOSED 回报后 hide；超时兜底 */
export function closeBubble(reason: string): void {
  const win = getBubbleWindow()
  if (!win || win.isDestroyed() || !win.isVisible() || bubbleState.closing) return
  beforeClose()
  bubbleState.closing = true
  console.log(`[bubble] 收起气泡（${reason}）——等待渲染侧退场动画回报`)
  sendTo(win, IPC_BUBBLE.REQUEST_CLOSE)
  closeTimer = setTimeout(() => {
    console.warn('[bubble] 退场动画回报超时，强制隐藏收尾')
    finishClose('超时兜底')
  }, CLOSE_TIMEOUT_MS)
}

/** 应用退出/窗口销毁后的收尾状态复位 */
export function resetLifecycle(): void {
  if (closeTimer) {
    clearTimeout(closeTimer)
    closeTimer = null
  }
  bubbleState.closing = false
}
