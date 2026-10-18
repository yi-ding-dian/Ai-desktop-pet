/**
 * 无边框窗口的通用拖动/缩放引擎（2026-10-18 窗口 UI 套件）。
 *
 * 背景：透明无边框窗口不能靠系统标题栏移动，也不该用 -webkit-app-region（设计文档 §5.1
 * 明确禁用）。渲染侧由 shared/ui 的 WindowTitleBar / WindowResizeHandles 采集手势，
 * 经 `frameless.move/resize` 上报；本模块按**发起消息的窗口**执行 setBounds。
 *
 * 设计要点：
 *  - IPC 只注册一次（main.ts 的 app ready 调 `initFramelessWindows()`），按 sender 找到窗口，
 *    未注册的窗口调用一律忽略（设置窗等原生标题栏窗口不受影响）；
 *  - 每个窗口一份状态（WeakMap）：是否可交互、工作区、变更回调、拖动起点；
 *  - 几何**只信请求值**（request-bounds 缓存），禁止把 getBounds 的舍入宽高回喂——
 *    fractional DPI 下会累积放大（历史 bug：按住边缘不动窗口自己往下跑）；
 *  - 拖动用"相对起点的累计位移"（每帧绝对值），缩放用渲染侧算出的绝对目标尺寸；
 *    目标未变时直接丢弃，断开"窗口变化 → pointermove → 再上报"的反馈环；
 *  - 程序化改变（折叠/展开动画）走 `applyFramelessBounds`，不触发 onBoundsChanged
 *    （业务记忆只在用户手势后更新）。
 */
import { BrowserWindow, ipcMain, screen } from 'electron'
import {
  IPC,
  type FramelessMovePayload,
  type FramelessResizePayload
} from '../ipc/channels'
import {
  moveFramelessRect,
  resizeFramelessRect,
  type FramelessSizeLimits
} from './frameless-geometry'
import type { Rect } from './index'
import {
  applyRequestedBounds,
  clearRequestedBounds,
  noteRequestedBounds,
  readRequestedBounds
} from './request-bounds'

export interface FramelessOptions extends FramelessSizeLimits {
  /** 交互闸门：动画/折叠期间返回 false（拖动与缩放都忽略） */
  canInteract?: () => boolean
  /** 用户拖动/缩放后回调（程序化 setBounds 不触发；黑板用它写形态记忆 + 宠物讲台跟随） */
  onBoundsChanged?: (rect: Rect) => void
  /** 自定义工作区查询（默认按目标矩形所在显示器） */
  workAreaFor?: (rect: Rect) => Rect
  /** 窗口创建时的初始请求矩形（只记账，不额外 setBounds） */
  initialBounds?: Rect
}

interface FramelessState {
  options: FramelessOptions
  /** 标题栏拖动的手势起点矩形（phase=start 快照；move 以它为基准算累计位移） */
  moveOrigin: Rect | null
}

const attached = new WeakMap<BrowserWindow, FramelessState>()
let ipcRegistered = false

/** 注册通用拖动/缩放 IPC（main.ts app ready 调一次；幂等） */
export function initFramelessWindows(): void {
  if (ipcRegistered) return
  ipcRegistered = true

  ipcMain.on(IPC.WINDOW_CHROME_MOVE, (event, raw: unknown) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return
    const state = attached.get(win)
    if (!state || isBlocked(state)) return
    const payload = normalizeMovePayload(raw)
    if (!payload) return

    if (payload.phase === 'start') {
      state.moveOrigin = readRequestedBounds(win)
      return
    }
    if (payload.phase === 'end') {
      state.moveOrigin = null
      return
    }
    // 防御：start 丢失（旧 preload/异常时序）时把当前矩形当起点并丢弃本帧——
    // 绝不能拿"已移动后的当前值"作基准迭代，否则每帧都按 dx 平移会形成跑飞
    if (!state.moveOrigin) {
      state.moveOrigin = readRequestedBounds(win)
      return
    }
    const origin = state.moveOrigin
    const rawTarget: Rect = {
      x: origin.x + payload.dx,
      y: origin.y + payload.dy,
      width: origin.width,
      height: origin.height
    }
    const wa = workAreaOf(state.options, rawTarget)
    const next = moveFramelessRect(origin, payload.dx, payload.dy, wa, state.options)
    if (!next) return
    applyRequestedBounds(win, next)
    state.options.onBoundsChanged?.(next)
  })

  ipcMain.on(IPC.WINDOW_CHROME_RESIZE, (event, raw: unknown) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return
    const state = attached.get(win)
    if (!state || isBlocked(state)) return
    const target = normalizeResizePayload(raw)
    if (!target) return
    const cur = readRequestedBounds(win)
    const wa = workAreaOf(state.options, cur)
    const next = resizeFramelessRect(cur, target, wa, state.options)
    if (!next) return // 目标与当前一致：不 setBounds（断开反馈环）
    applyRequestedBounds(win, next)
    state.options.onBoundsChanged?.(next)
  })
}

/**
 * 把窗口纳入通用拖动/缩放（黑板在 createBoardWindow 时调用）。返回 detach（窗口销毁时调）。
 */
export function attachFrameless(win: BrowserWindow, options: FramelessOptions): () => void {
  initFramelessWindows()
  if (options.initialBounds) noteRequestedBounds(win, options.initialBounds)
  const state: FramelessState = { options, moveOrigin: null }
  attached.set(win, state)

  const onClosed = (): void => {
    attached.delete(win)
    clearRequestedBounds(win)
  }
  win.once('closed', onClosed)

  return () => {
    win.removeListener('closed', onClosed)
    attached.delete(win)
    clearRequestedBounds(win)
  }
}

/** 读窗口最近一次请求矩形（业务域用它算讲台位/记忆，不直接 getBounds） */
export function framelessBounds(win: BrowserWindow): Rect {
  return readRequestedBounds(win)
}

/** 程序化写窗口矩形（动画/初始定位/静默归位）：记账 + setBounds，不触发 onBoundsChanged */
export function applyFramelessBounds(win: BrowserWindow, rect: Rect): void {
  applyRequestedBounds(win, rect)
}

/** 只记账不 setBounds（窗口构造时已按该矩形创建时用） */
export function noteFramelessBounds(win: BrowserWindow, rect: Rect): void {
  noteRequestedBounds(win, rect)
}

// ------------------------------------------------------------------ 内部

function isBlocked(state: FramelessState): boolean {
  return Boolean(state.options.canInteract && !state.options.canInteract())
}

function workAreaOf(options: FramelessOptions, rect: Rect): Rect {
  if (options.workAreaFor) return options.workAreaFor(rect)
  return screen.getDisplayMatching(rect).workArea
}

/** 校验拖动载荷（渲染侧异常/旧协议 → 忽略） */
function normalizeMovePayload(raw: unknown): FramelessMovePayload | null {
  if (!raw || typeof raw !== 'object') return null
  const v = raw as Record<string, unknown>
  if (v.phase !== 'start' && v.phase !== 'move' && v.phase !== 'end') return null
  if (typeof v.dx !== 'number' || !Number.isFinite(v.dx)) return null
  if (typeof v.dy !== 'number' || !Number.isFinite(v.dy)) return null
  return { phase: v.phase, dx: v.dx, dy: v.dy }
}

/** 校验缩放载荷 */
function normalizeResizePayload(raw: unknown): FramelessResizePayload | null {
  if (!raw || typeof raw !== 'object') return null
  const v = raw as Record<string, unknown>
  if (typeof v.width !== 'number' || !Number.isFinite(v.width)) return null
  if (typeof v.height !== 'number' || !Number.isFinite(v.height)) return null
  if (
    typeof v.left !== 'boolean' ||
    typeof v.right !== 'boolean' ||
    typeof v.top !== 'boolean' ||
    typeof v.bottom !== 'boolean'
  ) {
    return null
  }
  return {
    width: v.width,
    height: v.height,
    left: v.left,
    right: v.right,
    top: v.top,
    bottom: v.bottom
  }
}
