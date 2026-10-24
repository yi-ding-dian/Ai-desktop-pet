/** 气泡动作分发：白名单校验 + 菜单/确认/说话工具条动作。 */
import { IPC_EVENTS } from '../ipc/channels'
import { runHideAnimation } from '../ball-animation'
import { openSettings } from '../settings'
import { enterTeaching, exitTeaching, getTeachingMode } from '../teaching'
import { openWork } from '../work'
import {
  CLEAR_CHAT_CONFIRM,
  CONFIRM_ACTION_IDS,
  MENU_ACTION_IDS,
  SPEECH_ACTION_IDS
} from './constants'
import { openConfirmBubble } from './menu'
import { closeBubble, settleConfirm } from './lifecycle'
import {
  ackReminderBubble,
  stopSpeech,
  suppressSpeechRestoreNow
} from './speech'
import { bubbleState } from './state'

/** 向宠物窗发"请求清空聊天"（【清空】确认后；清空逻辑归后续任务） */
function requestClearChat(): void {
  const pet = bubbleState.petWin
  if (!pet || pet.isDestroyed() || pet.webContents.isDestroyed()) {
    console.warn('[bubble] 宠物窗口不可用，请求清空聊天未送达')
    return
  }
  pet.webContents.send(IPC_EVENTS.CHAT_CLEAR_REQUESTED)
  console.log('[bubble] 已向宠物窗发出「请求清空聊天」（清空逻辑归后续任务）')
}

/**
 * 分发气泡动作（白名单按当前内容校验——防渲染面误发）。
 * 动作执行与退场动画并行（先执行再 closeBubble 会让用户等待退场动画）。
 */
export function dispatchAction(id: string): void {
  const payload = bubbleState.currentPayload
  if (!payload) return
  const allowed =
    payload.variant === 'menu'
      ? MENU_ACTION_IDS.includes(id)
      : payload.variant === 'confirm'
        ? CONFIRM_ACTION_IDS.includes(id)
        : payload.variant === 'text'
          ? SPEECH_ACTION_IDS.includes(id)
          : false
  if (!allowed) {
    console.warn(`[bubble] 忽略非法动作 id：${id}`)
    return
  }
  console.log(`[bubble] 动作：${id}`)

  switch (id) {
    case 'teaching':
      suppressSpeechRestoreNow() // 进教学：菜单关闭后不恢复气泡
      if (getTeachingMode() === 'teaching') void exitTeaching('menu')
      else void enterTeaching('menu')
      closeBubble('动作：教学')
      break
    case 'work':
      // 工作模式：只是打开一个额外的聊天窗，说话气泡照常恢复（不抑制）
      openWork()
      closeBubble('动作：工作模式')
      break
    case 'settings':
      suppressSpeechRestoreNow() // 进设置向导：同理不恢复
      openSettings()
      closeBubble('动作：设置')
      break
    case 'hide-pet': {
      suppressSpeechRestoreNow() // 宠物隐藏：气泡不恢复
      const pet = bubbleState.petWin
      if (pet && !pet.isDestroyed()) void runHideAnimation(pet)
      closeBubble('动作：隐藏')
      break
    }
    case 'clear-chat':
      // 清空 = 破坏性操作：先换确认气泡（不关窗），确认后才执行
      suppressSpeechRestoreNow()
      void openConfirmBubble({ ...CLEAR_CHAT_CONFIRM, onConfirm: requestClearChat })
      break
    case 'confirm': {
      const pending = bubbleState.pendingConfirm
      if (!pending) {
        console.warn('[bubble] 收到 confirm，但没有待确认动作（已过期/重复点击）')
        closeBubble('动作：确认（无待确认项）')
        break
      }
      try {
        const action: unknown = pending.onConfirm()
        if (action && typeof (action as Promise<void>).catch === 'function') {
          void (action as Promise<void>).catch((err) => {
            console.warn('[bubble] 确认动作执行失败（忽略）：', err)
          })
        }
      } catch (err) {
        console.warn('[bubble] 确认动作执行失败（忽略）：', err)
      }
      settleConfirm(true)
      closeBubble('动作：确认')
      break
    }
    case 'cancel':
      settleConfirm(false)
      closeBubble('动作：取消')
      break
    case 'expand':
      // 说话气泡「展开」：打开工作模式窗，本气泡硬收且不恢复
      suppressSpeechRestoreNow()
      stopSpeech('展开进工作模式', true)
      openWork()
      break
    case 'close':
      // 说话气泡「✕」：收掉当前消息（提醒气泡的 ✕ 不等于已读）
      stopSpeech('气泡 ✕', false)
      break
    case 'reminder-ack':
      ackReminderBubble()
      break
    default:
      break
  }
}
