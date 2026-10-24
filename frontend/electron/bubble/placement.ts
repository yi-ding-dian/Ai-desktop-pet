/** 锚点计算与防出屏摆放（所有 setBounds 的统一收口）。 */
import { screen, type BrowserWindow } from 'electron'
import { computeBubblePlacement } from './geometry'
import { forceRepaint, sendTo } from './window'
import { bubbleState } from './state'
import { HEAD_ANCHOR_OFFSET, MAX_SIZE, MIN_SIZE } from './constants'
import { IPC_BUBBLE } from '../ipc/channels'
import { petWindowSize, type Point, type Rect, type Size } from '../window'
import { getPetScale } from '../pet-scale'

/** 当前锚点（屏幕坐标；宠物移动时由跟随逻辑重算） */
let anchor: Point | null = null
/**
 * 最近一次已知内容尺寸（DIP，含窗内留白）——follow 重摆**只允许用它**，不得读 win.getBounds()：
 * Windows fractional DPI 下 getBounds 会回吐舍入值，再喂回 setBounds 会每次 +1px 累积。
 */
let contentSize: Size | null = null
/** 最近一次实际下发的窗口 bounds（请求值）——相同则跳过 setBounds */
let lastAppliedBounds: Rect | null = null
/** 当前尾巴朝向（尺寸上报引发翻向时与 lastTail 比较后才下发 SET_TAIL） */
let lastTail: 'down' | 'up' = 'down'

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi)
}

export function setAnchor(next: Point | null): void {
  anchor = next
}

/** 弹出新内容时记录已下发的尾巴朝向（避免后续 SET_TAIL 重复下发） */
export function commitTail(tail: 'down' | 'up'): void {
  lastTail = tail
}

export function getContentSize(): Size | null {
  return contentSize
}

/**
 * 计算当前锚点（宠物窗位置 + 兔子头部偏移；宠物窗不可用返回 null）。
 * 缩放档位：x 以画布中心为基准，y 从画布顶部等比缩放。
 */
export function computeAnchor(): Point | null {
  const pet = bubbleState.petWin
  if (!pet || pet.isDestroyed()) return null
  const b = pet.getBounds()
  const scale = getPetScale()
  const winWidth = petWindowSize(scale).width
  return {
    x: Math.round(b.x + winWidth / 2 + (HEAD_ANCHOR_OFFSET.x - 135) * scale),
    y: Math.round(b.y + HEAD_ANCHOR_OFFSET.y * scale)
  }
}

/**
 * 按锚点摆放气泡窗（geometry 纯函数 + 所在显示器工作区）——所有 setBounds 的统一收口。
 * @returns 摆放决策出的尾巴朝向（调用方负责与 lastTail 比较、必要时下发 SET_TAIL）
 */
export function applyPlacement(win: BrowserWindow, size: Size): 'down' | 'up' {
  const a = anchor
  if (!a) return 'down'
  const width = Math.round(clamp(size.width, MIN_SIZE.width, MAX_SIZE.width))
  const height = Math.round(clamp(size.height, MIN_SIZE.height, MAX_SIZE.height))
  contentSize = { width, height }
  const wa = screen.getDisplayNearestPoint({ x: Math.round(a.x), y: Math.round(a.y) }).workArea
  const p = computeBubblePlacement(a, { width, height }, wa)
  const next: Rect = { x: p.x, y: p.y, width, height }
  const prev = lastAppliedBounds
  const same =
    prev !== null &&
    prev.x === next.x &&
    prev.y === next.y &&
    prev.width === next.width &&
    prev.height === next.height
  if (!same) {
    win.setBounds(next)
    lastAppliedBounds = next
    forceRepaint(win)
  }
  return p.tail
}

/** 按尺寸重摆气泡窗 + 翻向变化时轻量下发 SET_TAIL（不重播动画） */
export function reposition(win: BrowserWindow, size: Size): void {
  const tail = applyPlacement(win, size)
  if (tail !== lastTail) {
    lastTail = tail
    sendTo(win, IPC_BUBBLE.SET_TAIL, tail)
  }
  if (bubbleState.currentPayload) bubbleState.currentPayload = { ...bubbleState.currentPayload, tail }
}

/** 应用退出/窗口销毁后的定位状态复位 */
export function resetPlacement(): void {
  anchor = null
  contentSize = null
  lastAppliedBounds = null
  lastTail = 'down'
}
