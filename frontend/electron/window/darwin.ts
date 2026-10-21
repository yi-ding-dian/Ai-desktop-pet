/**
 * macOS 窗口实现 —— 降级兜底版（设计文档 §5.1：macOS 为远期平台，本期不实现）。
 *
 * 降级语义：不透明窗口 + 无穿透，保证未来在 macOS 上 registry 能返回一个"至少能跑"的实现；
 * 落地 macOS 时按本文件头部说明替换为真实实现（透明/穿透 Electron 在 macOS 均有原生能力）。
 *
 * 落地 macOS 时需注意三点（设计文档 §5.1）：
 *  ① alwaysOnTop 的 level 语义（floating 层级）；
 *  ② 全屏 Space 上的显示行为；
 *  ③ 分发必须 Apple 开发者账号签名 + 公证。
 */
import { BrowserWindow, screen } from 'electron'
import { initialPetPosition, type Size } from './index'
import type { PetWindowOptions, PlatformWindow, Point, Rect, WindowCapability } from './index'
import { createEasedMover, readGeometry } from './move'
import { isWindowMoveLocked } from './move-lock'

export function createDarwinWindow(opts: PetWindowOptions): PlatformWindow {
  const win = new BrowserWindow({
    width: opts.width,
    height: opts.height,
    // ---- 降级形态：不透明（透明待 macOS 实现落地）----
    transparent: false,
    backgroundColor: '#2b2b2b',
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    hasShadow: false,
    show: false,
    webPreferences: {
      preload: opts.preload,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  })

  const pos = initialPetPosition(screen.getPrimaryDisplay().workArea, {
    width: opts.width,
    height: opts.height
  })
  win.setPosition(pos.x, pos.y)

  let dragOrigin: { start: Point; bounds: Rect } | null = null
  /** 当前窗口尺寸（宠物缩放档位可调；拖拽/缓动移动都必须取它，不能写死基准值） */
  let currentSize: Size = { width: opts.width, height: opts.height }
  /** 缓动移动器（P3 行为引擎：walk 的窗口移动） */
  const mover = createEasedMover(win, () => currentSize)

  const capability: WindowCapability = {
    // 降级：无穿透（恒不拦截，即恒接收事件；此处语义为"关"）
    setClickThrough(on: boolean) {
      console.warn(`[window/darwin] 降级实现：穿透不可用（忽略 setClickThrough(${on})）`)
    },

    isClickThrough: () => false,

    setAlwaysOnTop(on: boolean) {
      win.setAlwaysOnTop(on)
      console.log(`[window/darwin] alwaysOnTop -> ${on}`)
    },

    isAlwaysOnTop: () => win.isAlwaysOnTop(),

    startDrag(cursor: Point) {
      // 魔法球动画期间不接受拖拽（动画逐帧改窗口尺寸，快照 bounds 可能是缩小态）
      if (isWindowMoveLocked()) return
      // 坐标由渲染侧 pointermove 事件驱动（与 Linux 实现统一）
      dragOrigin = { start: cursor, bounds: win.getBounds() }
    },

    dragMove(cursor: Point) {
      if (isWindowMoveLocked()) return
      if (!dragOrigin) return
      const { start, bounds } = dragOrigin
      // 尺寸用设计常量、不回喂 getBounds()（fractional DPI 下每次 +1px；
      // 见 window/index.ts 的 PET_WINDOW_SIZE 说明）
      win.setBounds({
        x: Math.round(bounds.x + (cursor.x - start.x)),
        y: Math.round(bounds.y + (cursor.y - start.y)),
        width: currentSize.width,
        height: currentSize.height
      })
    },

    endDrag() {
      if (!dragOrigin) return
      dragOrigin = null
    },

    applySize(size: Size) {
      // 底部中心锚定：脚底/输入框位置不动，向左右/上方生长（宠物缩放）
      if (currentSize.width === size.width && currentSize.height === size.height) return
      const b = win.getBounds()
      currentSize = { width: size.width, height: size.height }
      win.setBounds({
        x: Math.round(b.x + (b.width - size.width) / 2),
        y: Math.round(b.y + b.height - size.height),
        width: size.width,
        height: size.height
      })
    },

    getWorkArea(): Rect {
      return screen.getDisplayMatching(win.getBounds()).workArea
    },

    // P3 自主行为引擎：缓动移动（单次 IPC 一次移动；完成/取消 resolve）
    moveTo: (x, y, durationMs) => mover.moveTo(x, y, durationMs),
    cancelMove: () => mover.cancelMove(),
    getGeometry: () => readGeometry(win)
  }

  return {
    window: win,
    capability,
    // 降级实现（未实现 macOS 原生能力）
    degraded: true
  }
}
