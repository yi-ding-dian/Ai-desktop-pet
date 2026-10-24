/**
 * 气泡窗域（用户定稿"气泡系统"）入口：IPC 接线 + 生命周期。
 *
 * 目录分工：
 * - ``window.ts``    气泡窗（懒创建 / 就绪握手 / 形状 / 隐藏复用或销毁重建）；
 * - ``placement.ts`` 锚点计算与防出屏摆放；
 * - ``speech.ts``    说话气泡（出现/流式更新/空闲收起/悬浮交互/右键菜单/让位恢复）；
 * - ``menu.ts``      菜单气泡与确认气泡；
 * - ``actions.ts``   气泡动作分发；
 * - ``lifecycle.ts`` 收尾（退场等待 / 隐藏 / 销毁）；
 * - ``state.ts``     跨模块共享状态。
 *
 * 为什么独立窗口、交互两态、定位与动画分工、说话气泡行为与平台残屏规避，
 * 见 docs/reports/frontend/2026-10-15-bubble-system.md（文件头历史说明已随拆分下放到各模块）。
 */
import { ipcMain, screen, type BrowserWindow } from 'electron'
import {
  IPC,
  IPC_BUBBLE,
  type BubbleRequest,
  type BubbleSayBeginPayload,
  type BubbleSayEndPayload,
  type BubbleSayTextPayload,
  type BubbleSpeechMeta
} from '../ipc/channels'
import { dispatchAction } from './actions'
import { closeBubble, finishClose, resetLifecycle, setCloseHooks, settleConfirm } from './lifecycle'
import { openMenuBubble } from './menu'
import { reposition, resetPlacement } from './placement'
import {
  beginSpeech,
  clearSpeechIdleTimer,
  endSpeechBubble,
  maybeRestoreSpeech,
  onPetMoved,
  setNextSpeechTtl,
  setSpeechActivity,
  setSpeechIdleSeconds,
  showSpeechContextMenu,
  stopSpeechHoverPoll,
  touchSpeech,
  updateSpeechBubble,
  resetSpeech
} from './speech'
import { bubbleState, resetSharedState } from './state'
import {
  destroyBubbleWindowFully,
  getBubbleWindow,
  isBubbleSender,
  isPetSender,
  isSpeechShowing,
  markBubbleReady,
  pointInsideBubble,
  setBlurHandler,
  setShapeRects,
  warmBubbleWindow
} from './window'
import type { Rect } from '../window'

export { openConfirmBubble } from './menu'
export { setEdgeSpeechSuppression } from './speech'

/** ipcMain 监听是否已注册（只能注册一次，重复注册会叠加处理器） */
let ipcRegistered = false

/** REQUEST_OPEN 载荷校验（本期只有 { kind:'menu' }） */
function isMenuRequest(request: unknown): request is BubbleRequest {
  return Boolean(request && typeof request === 'object' && (request as BubbleRequest).kind === 'menu')
}

/** 应用退出清理（will-quit；气泡窗直接销毁，不做额外等待） */
export function destroyBubble(): void {
  settleConfirm(false)
  destroyBubbleWindowFully()
  resetLifecycle()
  resetSpeech()
  resetPlacement()
  resetSharedState()
}

/**
 * 注册气泡域 IPC 处理器（main.ts 在 app ready 后调用一次）。
 * @param pet 宠物窗口（锚点计算/请求清空路由/隐藏动作的对象）
 */
export function initBubble(pet: BrowserWindow): void {
  bubbleState.petWin = pet
  if (ipcRegistered) return
  ipcRegistered = true

  // 失焦收起（window 模块不直接依赖 lifecycle）
  setBlurHandler(() => closeBubble('blur（点击别处）'))
  // 收尾前后：清说话计时器 / 菜单关闭后恢复说话气泡
  setCloseHooks({
    before: () => {
      clearSpeechIdleTimer()
      stopSpeechHoverPoll()
    },
    after: maybeRestoreSpeech
  })

  // 说话气泡跟随：宠物走动/被拖拽时气泡随机重摆（缩放只改尺寸，单独监听 resize）
  pet.on('move', onPetMoved)
  pet.on('resize', onPetMoved)

  // 弹出请求：唯一入口 = 宠物窗（右键菜单）；其它渲染面/脏载荷一律忽略
  ipcMain.on(IPC.BUBBLE_REQUEST_OPEN, (event, request: unknown) => {
    if (!isPetSender(event.sender)) return
    if (!isMenuRequest(request)) return
    // 右键实际落在说话气泡上、但事件被宠物窗收到：改为气泡的复制菜单
    const requestX = Number(request.x)
    const requestY = Number(request.y)
    const point =
      Number.isFinite(requestX) && Number.isFinite(requestY)
        ? { x: requestX, y: requestY }
        : screen.getCursorScreenPoint()
    if (isSpeechShowing() && pointInsideBubble(point)) {
      const win = getBubbleWindow()
      console.log('[bubble] 右键落在说话气泡上 → 改为复制菜单（不让位宠物菜单）')
      if (win && !win.isDestroyed()) {
        void win.webContents
          .executeJavaScript(`window.getSelection ? window.getSelection().toString() : ''`)
          .then((text: unknown) => showSpeechContextMenu(typeof text === 'string' ? text : ''))
          .catch(() => showSpeechContextMenu(''))
      } else {
        showSpeechContextMenu('')
      }
      return
    }
    console.log('[bubble] 收到弹出请求（menu）')
    void openMenuBubble()
  })

  // 气泡页就绪：唤醒等待队列
  ipcMain.on(IPC_BUBBLE.READY, (event) => {
    if (!isBubbleSender(event.sender)) return
    markBubbleReady()
  })

  // 内容尺寸上报：按真实尺寸重定位（防出屏）
  ipcMain.on(IPC_BUBBLE.REPORT_SIZE, (event, size: unknown) => {
    if (!isBubbleSender(event.sender)) return
    const win = getBubbleWindow()
    if (!win || win.isDestroyed() || !win.isVisible() || bubbleState.closing) return
    const s = size as { width?: unknown; height?: unknown } | null
    const width = Number(s?.width)
    const height = Number(s?.height)
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return
    reposition(win, { width, height })
    console.log(
      `[bubble] 尺寸上报 ${Math.round(width)}x${Math.round(height)} → 窗 ${win.getBounds().width}x${win.getBounds().height}`
    )
  })

  // 内容交互矩形上报（说话气泡悬浮交互；形状外完全穿透）
  ipcMain.on(IPC_BUBBLE.REPORT_SHAPE, (event, rects: unknown) => {
    if (!isBubbleSender(event.sender)) return
    if (!Array.isArray(rects)) return
    const cleaned: Rect[] = []
    for (const item of rects) {
      const r = item as Partial<Rect> | null
      const x = Number(r?.x)
      const y = Number(r?.y)
      const width = Number(r?.width)
      const height = Number(r?.height)
      if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) continue
      cleaned.push({
        x: Math.round(x),
        y: Math.round(y),
        width: Math.round(width),
        height: Math.round(height)
      })
    }
    if (cleaned.length === 0) return
    setShapeRects(cleaned)
  })

  // 说话气泡三件套（只认宠物窗——chat 域的驱动）
  ipcMain.on(IPC_BUBBLE.SAY_BEGIN, (event, payload: unknown) => {
    if (!isPetSender(event.sender)) return
    const meta: BubbleSpeechMeta =
      (payload as BubbleSayBeginPayload | null)?.meta ?? { kind: 'chat' }
    beginSpeech(meta)
  })
  ipcMain.on(IPC_BUBBLE.SAY_TEXT, (event, payload: unknown) => {
    if (!isPetSender(event.sender)) return
    const text = (payload as BubbleSayTextPayload | null)?.text
    if (typeof text !== 'string') return
    updateSpeechBubble(text)
  })
  ipcMain.on(IPC_BUBBLE.SAY_END, (event, payload: unknown) => {
    if (!isPetSender(event.sender)) return
    endSpeechBubble((payload as BubbleSayEndPayload | null)?.immediate === true)
  })

  // 本地短提示：只覆盖下一次 SAY_BEGIN 的空闲时长
  ipcMain.on(IPC_BUBBLE.SET_NEXT_SPEECH_TTL, (event, ms: unknown) => {
    if (!isPetSender(event.sender)) return
    const value = Number(ms)
    if (!Number.isFinite(value)) return
    setNextSpeechTtl(value)
  })

  // 回复气泡自动收起：设置时长 / 新消息重置 / 悬浮选中暂停
  ipcMain.on(IPC_BUBBLE.SET_IDLE_TTL, (event, seconds: unknown) => {
    if (!isPetSender(event.sender)) return
    const value = Number(seconds)
    if (!Number.isFinite(value)) return
    setSpeechIdleSeconds(value)
  })
  ipcMain.on(IPC_BUBBLE.SPEECH_TOUCH, (event) => {
    if (!isPetSender(event.sender)) return
    touchSpeech()
  })
  ipcMain.on(IPC_BUBBLE.SPEECH_ACTIVITY, (event, payload: unknown) => {
    if (!isBubbleSender(event.sender)) return
    setSpeechActivity((payload as { paused?: unknown } | null)?.paused === true)
  })
  ipcMain.on(IPC_BUBBLE.REQUEST_CONTEXT_MENU, (event, payload: unknown) => {
    if (!isBubbleSender(event.sender)) return
    const selectionText = (payload as { selectionText?: unknown } | null)?.selectionText
    if (typeof selectionText !== 'string') return
    showSpeechContextMenu(selectionText)
  })

  // 用户动作：按当前内容白名单校验后分发
  ipcMain.on(IPC_BUBBLE.ACTION, (event, id: unknown) => {
    if (!isBubbleSender(event.sender)) return
    if (typeof id !== 'string') return
    dispatchAction(id)
  })

  // 退场动画播毕：真正隐藏窗口收尾
  ipcMain.on(IPC_BUBBLE.CLOSED, (event) => {
    if (!isBubbleSender(event.sender)) return
    if (!bubbleState.closing) return
    finishClose('渲染侧退场回报')
  })

  console.log('[bubble] IPC 处理器已注册')

  // Windows（复用策略）：延迟预热气泡窗；Linux/macOS 走销毁重建，不预热
  warmBubbleWindow()
}
