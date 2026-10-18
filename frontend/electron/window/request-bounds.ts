/**
 * 窗口"请求值"矩形缓存（2026-10-18 窗口 UI 套件；平台无关）。
 *
 * 为什么需要：Windows fractional DPI（本机 175%）下 `setBounds(400×400)` 之后
 * `getBounds()` 会回吐舍入后的值（+1~2px）。任何"读几何 → 算新矩形 → 回喂 setBounds"
 * 的循环都会每轮放大一次并累积（历史现象：窗口越拖越大 / 按住边缘不动窗口自己往下跑）。
 *
 * 契约：
 *  - 本窗口的几何**只认最近一次请求值**（程序化移动、拖动/缩放都经这里记账）；
 *  - 需要读取时用 `readRequestedBounds`，不要在业务里直接 `getBounds()` 取宽高；
 *  - 外部来源（窗口刚创建、系统改分辨率）第一次读取时才回退到 getBounds。
 *
 * 缓存是 WeakMap：窗口销毁即释放，无需显式清理（仍提供 clear 以便测试/重建）。
 */
import type { BrowserWindow } from 'electron'
import type { Rect } from './index'

const cache = new WeakMap<BrowserWindow, Rect>()

/** 记录一份请求值（不调用 setBounds）——窗口刚创建、或由本模块之外刚 setBounds 过时用 */
export function noteRequestedBounds(win: BrowserWindow, rect: Rect): void {
  cache.set(win, { x: rect.x, y: rect.y, width: rect.width, height: rect.height })
}

/** 写请求值 + setBounds（窗口的**唯一**几何写入口） */
export function applyRequestedBounds(win: BrowserWindow, rect: Rect): void {
  noteRequestedBounds(win, rect)
  if (!win.isDestroyed()) win.setBounds(rect)
}

/** 读最近一次请求值；缺失（刚创建/外部改动）时读 getBounds 并记账 */
export function readRequestedBounds(win: BrowserWindow): Rect {
  const cached = cache.get(win)
  if (cached) return cached
  const b = win.getBounds()
  const rect: Rect = { x: b.x, y: b.y, width: b.width, height: b.height }
  cache.set(win, rect)
  return rect
}

/** 清掉缓存（窗口重建 / 测试用） */
export function clearRequestedBounds(win: BrowserWindow): void {
  cache.delete(win)
}
