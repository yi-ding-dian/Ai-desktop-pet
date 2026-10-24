/** 菜单气泡与确认气泡：内容组装、弹出、确认动作结清。 */
import { REUSE_BUBBLE_WINDOW } from '../platform'
import {
  IPC_BUBBLE,
  type BubbleMenuItemPayload,
  type BubbleOpenPayload
} from '../ipc/channels'
import { getTeachingMode } from '../teaching'
import { CONFIRM_TIMEOUT_MS, ESTIMATED_SIZE, READY_TIMEOUT_MS } from './constants'
import { applyPlacement, commitTail, computeAnchor, setAnchor } from './placement'
import { bubbleState } from './state'
import { closeBubble, finishClose, settleConfirm } from './lifecycle'
import { allowSpeechRestore, isSpeechActive, stopSpeech } from './speech'
import {
  ensureBubbleWindow,
  isSpeechShowing,
  scheduleOpenRepost,
  sendTo,
  waitBubbleReady
} from './window'

/** 确认气泡请求（主进程内部 IPC 用；onConfirm 可为空——删除文件由 IPC 处理器执行） */
export interface ConfirmRequest {
  message: string
  confirmLabel?: string
  cancelLabel?: string
  onConfirm?: () => void | Promise<void>
}

/** 组装菜单载荷（"开始教学" ⇄ "结束"由 teaching 域当前态决定） */
function buildMenuPayload(): BubbleOpenPayload {
  const teaching = getTeachingMode() === 'teaching'
  const items: BubbleMenuItemPayload[] = [
    { id: 'teaching', label: teaching ? '结束' : '开始教学', icon: 'teaching' },
    { id: 'work', label: '工作模式', icon: 'work' },
    { id: 'settings', label: '打开设置', icon: 'settings' },
    { id: 'clear-chat', label: '清空聊天', icon: 'broom' },
    { id: 'hide-pet', label: '隐藏', icon: 'sleep' }
  ]
  return {
    session: ++bubbleState.sessionSeq,
    variant: 'menu',
    tail: 'down',
    motion: { enter: 'light', exit: 'light' },
    stableWindow: REUSE_BUBBLE_WINDOW,
    items
  }
}

/** 组装确认载荷（清空聊天 / 删除本机文件共用） */
function buildConfirmPayload(request: ConfirmRequest): BubbleOpenPayload {
  return {
    session: ++bubbleState.sessionSeq,
    variant: 'confirm',
    tail: 'down',
    motion: { enter: 'light', exit: 'light' },
    stableWindow: REUSE_BUBBLE_WINDOW,
    message: request.message,
    confirmLabel: request.confirmLabel ?? '确定',
    cancelLabel: request.cancelLabel ?? '取消'
  }
}

/**
 * 弹出菜单气泡（本轮唯一入口：宠物窗右键）。
 * 幂等收敛：正在弹出时忽略；已在显示 → 重定位 + 重发内容；正在收起 → 先收尾再开。
 */
export async function openMenuBubble(): Promise<void> {
  if (bubbleState.opening) return
  // 右键菜单抢场：任何待确认动作按取消处理
  settleConfirm(false)
  bubbleState.opening = true
  try {
    const pet = bubbleState.petWin
    if (!pet || pet.isDestroyed()) {
      console.warn('[bubble] 宠物窗口不可用，无法弹出气泡')
      return
    }
    allowSpeechRestore()
    if (isSpeechActive() || isSpeechShowing()) stopSpeech('菜单让位', true, true)
    if (bubbleState.closing) finishClose('重新弹出前收尾')
    bubbleState.interactive = true

    const a = computeAnchor()
    if (!a) return
    setAnchor(a)

    const win = ensureBubbleWindow()
    if (!(await waitBubbleReady(READY_TIMEOUT_MS))) {
      console.warn(`[bubble] 气泡页 ${READY_TIMEOUT_MS}ms 未就绪，本次取消弹出`)
      return
    }
    if (win.isDestroyed()) return

    const payload = buildMenuPayload()
    const tail = applyPlacement(win, ESTIMATED_SIZE.menu)
    commitTail(tail)
    bubbleState.currentPayload = { ...payload, tail }

    win.moveTop()
    win.setIgnoreMouseEvents(!bubbleState.interactive)
    if (bubbleState.interactive) win.show()
    else win.showInactive()
    sendTo(win, IPC_BUBBLE.OPEN, bubbleState.currentPayload)
    scheduleOpenRepost(win)
    console.log(`[bubble] 菜单气泡已弹出 @ ${win.getBounds().x},${win.getBounds().y}（tail=${tail}）`)
  } catch (err) {
    console.error('[bubble] 弹出菜单气泡异常：', err)
  } finally {
    bubbleState.opening = false
  }
}

/**
 * 弹出确认气泡并等待用户选择（清空聊天 / 删除文件共用）。
 *
 * - 同一时间只有一个待确认动作；新请求会把旧请求按取消结清；
 * - 用户点「确认」：执行 onConfirm、resolve(true)、收起气泡；
 * - 取消 / 点别处 / 120s 超时：resolve(false)，什么都不做；
 * - 说话气泡让位（保留文本），确认关闭后恢复。
 */
export async function openConfirmBubble(request: ConfirmRequest): Promise<boolean> {
  settleConfirm(false)
  if (bubbleState.opening) {
    console.warn('[bubble] 气泡正在弹出，确认请求忽略')
    return false
  }
  const pet = bubbleState.petWin
  if (!pet || pet.isDestroyed()) {
    console.warn('[bubble] 宠物窗口不可用，无法弹出确认气泡')
    return false
  }

  bubbleState.opening = true
  let resolvePromise: (confirmed: boolean) => void = () => {}
  const result = new Promise<boolean>((resolve) => {
    resolvePromise = resolve
  })
  try {
    if (isSpeechActive() || isSpeechShowing()) stopSpeech('确认让位', true, true)
    if (bubbleState.closing) finishClose('确认弹出前收尾')
    bubbleState.interactive = true

    const a = computeAnchor()
    if (!a) return false
    setAnchor(a)

    const win = ensureBubbleWindow()
    if (!(await waitBubbleReady(READY_TIMEOUT_MS))) {
      console.warn(`[bubble] 气泡页 ${READY_TIMEOUT_MS}ms 未就绪，确认请求取消`)
      return false
    }
    if (win.isDestroyed()) return false

    const payload = buildConfirmPayload(request)
    const tail = applyPlacement(win, ESTIMATED_SIZE.confirm)
    commitTail(tail)
    bubbleState.currentPayload = { ...payload, tail }

    bubbleState.pendingConfirm = {
      onConfirm: request.onConfirm ?? (() => {}),
      resolve: resolvePromise,
      timer: setTimeout(() => {
        console.log(`[bubble] 确认气泡 ${CONFIRM_TIMEOUT_MS}ms 无操作，按取消处理`)
        settleConfirm(false)
        closeBubble('确认超时')
      }, CONFIRM_TIMEOUT_MS)
    }
    bubbleState.pendingConfirm.timer?.unref?.()

    win.moveTop()
    win.setIgnoreMouseEvents(false)
    win.show()
    win.focus()
    sendTo(win, IPC_BUBBLE.OPEN, bubbleState.currentPayload)
    scheduleOpenRepost(win)
    console.log('[bubble] 确认气泡已弹出（等待用户选择）')
    return result
  } catch (err) {
    console.error('[bubble] 弹出确认气泡异常：', err)
    settleConfirm(false)
    return false
  } finally {
    bubbleState.opening = false
  }
}
