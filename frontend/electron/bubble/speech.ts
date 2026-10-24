/** 说话气泡：出现/流式更新/常驻空闲收起/悬浮交互/右键菜单/让位恢复。 */
import { clipboard, Menu, screen } from 'electron'
import { isWindows, REUSE_BUBBLE_WINDOW } from '../platform'
import {
  IPC_BUBBLE,
  IPC_EVENTS,
  type BubbleOpenPayload,
  type BubbleSpeechEventPayload,
  type BubbleSpeechMeta,
  type BubbleUpdatePayload
} from '../ipc/channels'
import { getTeachingMode } from '../teaching'
import { followSize } from './geometry'
import {
  ESTIMATED_SIZE,
  FOLLOW_THROTTLE_MS,
  READY_TIMEOUT_MS
} from './constants'
import {
  applyPlacement,
  commitTail,
  computeAnchor,
  getContentSize,
  reposition,
  setAnchor
} from './placement'
import { bubbleState } from './state'
import { closeBubble, finishClose } from './lifecycle'
import {
  applyBubbleShape,
  ensureBubbleWindow,
  forceRepaint,
  getBubbleWindow,
  isMenuShowing,
  isSpeechShowing,
  pointInsideBubble,
  scheduleOpenRepost,
  sendTo,
  waitBubbleReady
} from './window'

// ---- 说话气泡状态（宠物面驱动的一次"说话"会话） ----
/** 说话会话活跃中（SAY_BEGIN 置位、SAY_END 复位） */
let speechActive = false
/** 会话作废（弹出期被打断/让位）——异步就绪等待回来后据此中止弹出 */
let speechCancelled = false
/** 菜单让位不恢复标记（菜单里点了教学/展开/设置/隐藏 → 不恢复） */
let suppressSpeechRestore = false
/** 最新文本快照 */
let speechText = ''
/** 本轮说话的消息属性（普通回复 / 提醒） */
let speechMeta: BubbleSpeechMeta | null = null
/** 回复气泡空闲自动收起时长（ms；0=不自动收） */
let speechIdleMs = 30_000
/** 本轮回复是否已进入"可自动收起"阶段 */
let speechIdleEligible = false
/** 悬浮/选中文字期间暂停计时 */
let speechIdlePaused = false
/** 空闲收起定时器 */
let speechIdleTimer: NodeJS.Timeout | null = null
/** 本轮说话的空闲时长覆盖（本地短提示 5s） */
let speechIdleOverrideMs: number | null = null
/** 下一次 SAY_BEGIN 使用的临时空闲时长 */
let pendingSpeechTtlMs: number | null = null
/** Windows 光标悬浮轮询 */
let speechHoverPoll: NodeJS.Timeout | null = null
let speechHoverInside = false
/** 宠物移动跟随节流标志 */
let followPending = false
/** 贴上/下边吸附抑制 */
let edgeSpeechSuppressed = false

/** 两条消息属性是否同一批（重复 SAY_BEGIN 幂等用） */
function sameSpeechMeta(a: BubbleSpeechMeta | null, b: BubbleSpeechMeta | null): boolean {
  if (a === null || b === null) return a === b
  return a.kind === b.kind && a.batchId === b.batchId && a.messageId === b.messageId
}

/**
 * 向宠物窗回传提醒气泡的生命周期：
 * - closed：气泡关闭 → 未读进列表；
 * - reminder-ack：用户点了「知道了」→ 宠物面发 ack_reminders。
 */
export function notifySpeechEvent(type: 'closed' | 'reminder-ack', reason?: string): void {
  const meta = speechMeta
  if (!meta || meta.kind !== 'reminder') return
  const pet = bubbleState.petWin
  if (!pet || pet.isDestroyed() || pet.webContents.isDestroyed()) return
  const payload: BubbleSpeechEventPayload = { type, meta, reason }
  try {
    pet.webContents.send(IPC_EVENTS.BUBBLE_SPEECH_EVENT, payload)
    console.log(`[bubble] 提醒气泡事件：${type}${reason ? `（${reason}）` : ''}`)
  } catch (err) {
    console.warn('[bubble] 回传提醒气泡事件失败（忽略）：', err)
  }
}

// ---- 回复气泡空闲自动收起 ----

export function clearSpeechIdleTimer(): void {
  if (speechIdleTimer !== null) {
    clearTimeout(speechIdleTimer)
    speechIdleTimer = null
  }
}

function scheduleSpeechIdleDismiss(): void {
  clearSpeechIdleTimer()
  const idleMs = speechIdleOverrideMs ?? speechIdleMs
  if (
    !speechIdleEligible ||
    speechIdlePaused ||
    speechHoverInside ||
    bubbleState.speechContextMenuOpen ||
    idleMs <= 0
  ) {
    return
  }
  if (!speechText || !isSpeechShowing() || isMenuShowing()) return
  if (getTeachingMode() === 'teaching') return
  speechIdleTimer = setTimeout(() => {
    speechIdleTimer = null
    if (!speechIdleEligible || speechIdlePaused || speechHoverInside) return
    if (!speechText || !isSpeechShowing()) return
    console.log(`[bubble] 空闲 ${idleMs}ms，自动收起说话气泡`)
    stopSpeech('空闲自动收起', false)
  }, idleMs)
  speechIdleTimer.unref?.()
}

export function stopSpeechHoverPoll(): void {
  if (speechHoverPoll !== null) {
    clearInterval(speechHoverPoll)
    speechHoverPoll = null
  }
  speechHoverInside = false
}

/**
 * Windows 兜底：气泡在宠物窗下层时渲染侧收不到 pointerenter。
 * 主进程轮询光标是否在气泡窗内；非 Windows 不轮询（X11 getCursorScreenPoint 会冻结）。
 */
function startSpeechHoverPoll(): void {
  if (!isWindows || speechHoverPoll !== null) return
  speechHoverPoll = setInterval(() => {
    if (!isSpeechShowing()) {
      stopSpeechHoverPoll()
      return
    }
    const inside = pointInsideBubble(screen.getCursorScreenPoint())
    if (inside === speechHoverInside) return
    speechHoverInside = inside
    if (inside) {
      clearSpeechIdleTimer()
    } else if (speechIdleEligible) {
      scheduleSpeechIdleDismiss()
    }
  }, 200)
  speechHoverPoll.unref?.()
}

/**
 * 说话气泡右键复制菜单：复制动作只写剪贴板，不收起气泡。
 */
export function showSpeechContextMenu(selectionText: string): void {
  if (bubbleState.speechContextMenuOpen) return
  if (!isSpeechShowing() || bubbleState.currentPayload?.variant !== 'text' || !speechText) {
    return
  }
  const selected = selectionText.replace(/\r\n/g, '\n')
  const template: Electron.MenuItemConstructorOptions[] = []
  if (selected.trim()) {
    template.push({
      label: '复制选中内容',
      click: () => clipboard.writeText(selected)
    })
  }
  template.push({
    label: '复制整条消息',
    click: () => clipboard.writeText(speechText)
  })
  template.push({ type: 'separator' })
  template.push({
    label: '收起气泡',
    click: () => stopSpeech('右键收起', false)
  })
  console.log(`[bubble] 右键菜单（选中 ${selected.length} 字）`)
  const win = getBubbleWindow()
  bubbleState.interactive = false
  bubbleState.speechContextMenuOpen = true
  clearSpeechIdleTimer()
  const onClosed = (): void => {
    bubbleState.speechContextMenuOpen = false
    if (speechIdleEligible) scheduleSpeechIdleDismiss()
  }
  try {
    Menu.buildFromTemplate(template).popup(
      win && !win.isDestroyed() ? { window: win, callback: onClosed } : { callback: onClosed }
    )
  } catch {
    onClosed()
  }
}

// ---- 收起 / 恢复 ----

/**
 * 收起说话气泡。
 * - 已显示：hard=true 立即隐藏收尾；hard=false 播轻量退场；
 * - 尚未显示：标记会话作废。
 * keepText=true 保留文本快照（菜单让位专用）。
 */
export function stopSpeech(
  reason: string,
  hard: boolean,
  keepText = false,
  notifyClose = true
): void {
  speechActive = false
  clearSpeechIdleTimer()
  stopSpeechHoverPoll()
  speechIdlePaused = false
  if (!keepText) {
    if (notifyClose) notifySpeechEvent('closed', reason)
    speechMeta = null
    speechText = ''
    speechIdleEligible = false
    speechIdleOverrideMs = null
    pendingSpeechTtlMs = null
  }
  const showing = isSpeechShowing()
  if (!showing) speechCancelled = true
  console.log(`[bubble] 说话气泡收起（${reason}${hard ? '，硬收' : ''}${showing ? '' : '，弹出中作废'}）`)
  if (!showing) return
  if (hard) finishClose(`说话让位（${reason}）`)
  else closeBubble(`说话收起（${reason}）`)
}

/**
 * 贴上/下边吸附时抑制说话气泡（幂等）。
 * 抑制开：硬收但保留文本与属性；抑制关：内容还在就恢复。
 */
export function setEdgeSpeechSuppression(suppressed: boolean): void {
  if (suppressed === edgeSpeechSuppressed) return
  edgeSpeechSuppressed = suppressed
  if (suppressed) {
    console.log('[bubble] 贴上/下边吸附——收起说话气泡（保留内容，离开后恢复）')
    if (speechActive || isSpeechShowing()) stopSpeech('贴上/下边让位', true, true)
    return
  }
  console.log('[bubble] 已离开上/下边——尝试恢复说话气泡')
  maybeRestoreSpeech()
}

/**
 * 菜单收尾后恢复说话气泡（"不消失"体验闭环）。
 */
export function isSpeechActive(): boolean {
  return speechActive
}

export function maybeRestoreSpeech(): void {
  if (edgeSpeechSuppressed) return
  if (suppressSpeechRestore || !speechText) {
    notifySpeechEvent('closed', 'menu-suppressed')
    speechMeta = null
    speechIdleEligible = false
    clearSpeechIdleTimer()
    return
  }
  if (bubbleState.opening) return
  if (isSpeechShowing()) return
  if (getTeachingMode() === 'teaching') return
  const pet = bubbleState.petWin
  if (!pet || pet.isDestroyed() || !pet.isVisible()) return
  console.log('[bubble] 菜单收起——恢复说话气泡（内容仍在）')
  void openSpeechBubble()
}

/** 菜单让位/进教学设置隐藏：标记关闭后不恢复，并清掉文本 */
export function suppressSpeechRestoreNow(): void {
  suppressSpeechRestore = true
  speechText = ''
}

/** 新菜单会话：普通关闭（blur）时恢复说话气泡 */
export function allowSpeechRestore(): void {
  suppressSpeechRestore = false
}

/** 提醒气泡「知道了」：回执已读并收起（不再进未读列表） */
export function ackReminderBubble(): void {
  if (speechMeta?.kind !== 'reminder') {
    console.warn('[bubble] 忽略非提醒气泡的 reminder-ack')
    return
  }
  notifySpeechEvent('reminder-ack', '知道了')
  speechMeta = null
  speechText = ''
  speechIdleEligible = false
  stopSpeech('提醒已读', false, false, false)
}

// ---- 弹出 / 更新 ----

/** 组装说话气泡载荷（纯展示态，"轻量展开"动画） */
function buildSpeechPayload(
  message: string,
  meta: BubbleSpeechMeta | null = null
): BubbleOpenPayload {
  return {
    session: ++bubbleState.sessionSeq,
    variant: 'text',
    tail: 'down',
    motion: { enter: 'light', exit: 'light' },
    stableWindow: REUSE_BUBBLE_WINDOW,
    message,
    meta: meta ?? undefined
  }
}

/**
 * 说话气泡出现（SAY_BEGIN 入口）。
 * - 菜单/确认显示中 → 忽略；
 * - 幂等：活跃中重复 begin 忽略；
 * - 常驻复用：上一条还显示中 → 原地刷新内容；
 * - 就绪等待期间到达的文本存 speechText，就绪后补发。
 */
export async function openSpeechBubble(): Promise<void> {
  if (bubbleState.opening) return
  if (edgeSpeechSuppressed) {
    console.log('[bubble] 贴上/下边吸附中，本轮说话气泡暂不显示')
    return
  }
  if (isMenuShowing()) {
    console.log('[bubble] 菜单显示中，本轮说话气泡忽略')
    return
  }
  if (speechActive) return
  bubbleState.opening = true
  try {
    const pet = bubbleState.petWin
    if (!pet || pet.isDestroyed()) return
    if (bubbleState.closing) finishClose('说话气泡弹出前收尾')
    speechActive = true
    speechCancelled = false

    if (isSpeechShowing()) {
      console.log('[bubble] 复用当前说话气泡（原地刷新内容）')
      const prev = bubbleState.currentPayload
      if (prev && prev.variant === 'text') {
        bubbleState.currentPayload = { ...prev, meta: speechMeta ?? undefined }
        sendTo(getBubbleWindow(), IPC_BUBBLE.UPDATE, {
          session: prev.session,
          message: prev.message,
          meta: speechMeta ?? undefined
        } as BubbleUpdatePayload)
      }
      startSpeechHoverPoll()
      scheduleSpeechIdleDismiss()
      return
    }

    const a = computeAnchor()
    if (!a) {
      speechActive = false
      return
    }
    setAnchor(a)

    const win = ensureBubbleWindow()
    if (!(await waitBubbleReady(READY_TIMEOUT_MS))) {
      console.warn(`[bubble] 气泡页 ${READY_TIMEOUT_MS}ms 未就绪，本次说话气泡取消`)
      speechActive = false
      return
    }
    if (win.isDestroyed()) {
      speechActive = false
      return
    }
    if (speechCancelled) {
      speechCancelled = false
      speechActive = false
      return
    }

    bubbleState.interactive = false
    const payload = buildSpeechPayload(speechText, speechMeta)
    const tail = applyPlacement(win, ESTIMATED_SIZE.text)
    commitTail(tail)
    bubbleState.currentPayload = { ...payload, tail }

    win.moveTop()
    win.setIgnoreMouseEvents(false)
    applyBubbleShape()
    win.showInactive()
    sendTo(win, IPC_BUBBLE.OPEN, bubbleState.currentPayload)
    scheduleOpenRepost(win)
    forceRepaint(win) // 显示后再补一发（applyPlacement 已重绘一次——双保险）
    console.log(
      `[bubble] 说话气泡已弹出 @ ${win.getBounds().x},${win.getBounds().y}（tail=${tail}，悬浮可交互）`
    )
    if (speechText) updateSpeechBubble(speechText)
    startSpeechHoverPoll()
    scheduleSpeechIdleDismiss()
  } catch (err) {
    console.error('[bubble] 弹出说话气泡异常：', err)
    speechActive = false
  } finally {
    bubbleState.opening = false
  }
}

/**
 * 说话气泡文本快照更新（SAY_TEXT）：同 session UPDATE。
 */
export function updateSpeechBubble(text: string): void {
  speechText = text
  clearSpeechIdleTimer()
  if (!speechActive || !isSpeechShowing()) return
  const win = getBubbleWindow()
  const payload = bubbleState.currentPayload
  if (!win || !payload || payload.variant !== 'text') return
  bubbleState.currentPayload = { ...payload, message: text, meta: speechMeta ?? undefined }
  const update: BubbleUpdatePayload = {
    session: payload.session,
    message: text,
    meta: speechMeta ?? undefined
  }
  sendTo(win, IPC_BUBBLE.UPDATE, update)
  if (speechIdleEligible) scheduleSpeechIdleDismiss()
}

/**
 * 说话结束（SAY_END）：
 * - immediate：立刻收起/作废（清文本，不复活）；
 * - 缺省：常驻，开始空闲计时。
 */
export function endSpeechBubble(immediate: boolean): void {
  if (immediate) {
    speechIdleEligible = false
    clearSpeechIdleTimer()
    if (speechActive || isSpeechShowing()) stopSpeech('被打断/让位', false)
    return
  }
  if (!speechActive) {
    if (speechText) {
      speechIdleEligible = true
      scheduleSpeechIdleDismiss()
    }
    return
  }
  speechActive = false
  speechIdleEligible = true
  console.log(
    `[bubble] 说话结束（${speechText.length} 字）——气泡常驻，${speechIdleMs > 0 ? `${speechIdleMs}ms 空闲后收起` : '不自动收起'}`
  )
  scheduleSpeechIdleDismiss()
}

/** SAY_BEGIN 的会话初始化（消息属性 / 临时空闲时长 / 清空快照） */
export function beginSpeech(meta: BubbleSpeechMeta): void {
  if (speechMeta?.kind === 'reminder' && !sameSpeechMeta(speechMeta, meta)) {
    notifySpeechEvent('closed', 'replaced')
  }
  speechMeta = meta
  clearSpeechIdleTimer()
  speechIdleEligible = false
  if (pendingSpeechTtlMs !== null) {
    speechIdleOverrideMs = pendingSpeechTtlMs
    pendingSpeechTtlMs = null
  } else {
    speechIdleOverrideMs = null
  }
  speechText = ''
  void openSpeechBubble()
}

/** SET_IDLE_TTL：设置回复气泡空闲收起时长（秒；0=不自动收） */
export function setSpeechIdleSeconds(seconds: number): void {
  speechIdleMs = seconds <= 0 ? 0 : Math.min(300, Math.max(5, Math.round(seconds))) * 1000
  console.log(
    `[bubble] 回复气泡空闲收起时长 -> ${speechIdleMs > 0 ? `${speechIdleMs}ms` : '不自动收'}`
  )
  clearSpeechIdleTimer()
  if (speechIdleEligible) scheduleSpeechIdleDismiss()
}

/** SET_NEXT_SPEECH_TTL：只覆盖下一轮说话的空闲时长 */
export function setNextSpeechTtl(ms: number): void {
  pendingSpeechTtlMs = Math.min(60_000, Math.max(1_000, Math.round(ms)))
  console.log(`[bubble] 下一轮说话临时空闲时长 -> ${pendingSpeechTtlMs}ms`)
}

/** SPEECH_TOUCH：用户发送了新消息，重置空闲计时 */
export function touchSpeech(): void {
  if (!speechIdleEligible) return
  scheduleSpeechIdleDismiss()
}

/** SPEECH_ACTIVITY：气泡面悬浮/选中文字暂停自动收起 */
export function setSpeechActivity(paused: boolean): void {
  speechIdlePaused = paused
  if (paused) clearSpeechIdleTimer()
  else if (!speechHoverInside && speechIdleEligible) scheduleSpeechIdleDismiss()
}

/** 宠物移动跟随（说话气泡绑定兔子；节流重摆） */
export function onPetMoved(): void {
  if (!isSpeechShowing()) return
  if (followPending) return
  followPending = true
  setTimeout(() => {
    followPending = false
    const win = getBubbleWindow()
    if (!win || win.isDestroyed() || !isSpeechShowing()) return
    const a = computeAnchor()
    if (!a) return
    setAnchor(a)
    reposition(win, followSize(getContentSize(), ESTIMATED_SIZE.text))
  }, FOLLOW_THROTTLE_MS)
}

/** 应用退出/窗口销毁后的说话状态复位 */
export function resetSpeech(): void {
  speechActive = false
  speechCancelled = false
  suppressSpeechRestore = false
  speechText = ''
  speechMeta = null
  speechIdleMs = 30_000
  speechIdleEligible = false
  speechIdlePaused = false
  speechIdleOverrideMs = null
  pendingSpeechTtlMs = null
  edgeSpeechSuppressed = false
  clearSpeechIdleTimer()
  stopSpeechHoverPoll()
}
