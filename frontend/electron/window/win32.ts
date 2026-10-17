/**
 * Windows 窗口实现（按统一接口书写）。
 *
 * ⚠ 未在 Windows 验证：本文件按 Electron 官方文档与 Windows 平台已知差异编写，
 *   落地 Windows 前需在真机回归（重点：透明 + 穿透 + 拖拽跟随）。
 *
 * Windows 平台已知差异（相对 Linux）：
 * 1. setIgnoreMouseEvents(on, { forward: true }) 的 forward 有官方支持，穿透期可收到 mousemove
 *    → 渲染侧悬停检测可正常工作，无需 Linux 式形状方案。
 * 2. 透明窗口与 resizable/dwm 组合有坑：transparent + resizable:true 会导致透明失效，
 *    故保持 resizable:false（与桌宠需求一致）。
 * 3. alwaysOnTop 可指定层级（'screen-saver' 可压住全屏应用），需要时在 setAlwaysOnTop 内升级。
 */
import { BrowserWindow, screen } from 'electron'
import type { PetWindowOptions, PlatformWindow, Point, Rect, WindowCapability } from './index'
import { createEasedMover, readGeometry } from './move'
import { isWindowMoveLocked } from './move-lock'

export function createWin32Window(opts: PetWindowOptions): PlatformWindow {
  const win = new BrowserWindow({
    width: opts.width,
    height: opts.height,
    // ---- 桌宠窗口基础形态（设计文档 §5.1）----
    transparent: true,
    backgroundColor: '#00000000',
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

  // 初始位置：主屏工作区底部居中
  const workArea = screen.getPrimaryDisplay().workArea
  win.setPosition(
    Math.round(workArea.x + (workArea.width - opts.width) / 2),
    Math.round(workArea.y + workArea.height - opts.height - 48)
  )

  let clickThrough = false
  let dragOrigin: { start: Point; bounds: Rect } | null = null
  /** 缓动移动器（P3 行为引擎：walk 的窗口移动） */
  const mover = createEasedMover(win)

  const capability: WindowCapability = {
    setClickThrough(on: boolean) {
      if (clickThrough === on) return
      clickThrough = on
      win.setIgnoreMouseEvents(on, { forward: true })
      console.log(`[window/win32] clickThrough -> ${on}`)
    },

    isClickThrough: () => clickThrough,

    setAlwaysOnTop(on: boolean) {
      win.setAlwaysOnTop(on)
      console.log(`[window/win32] alwaysOnTop -> ${on}`)
    },

    isAlwaysOnTop: () => win.isAlwaysOnTop(),

    startDrag(cursor: Point) {
      // 魔法球动画期间不接受拖拽：动画在逐帧改窗口尺寸，此时快照到的 bounds 可能是缩小态，
      // 拖拽会把它一直保持在小尺寸（兔头/身体被裁）。动画结束后再允许拖拽。
      if (isWindowMoveLocked()) return
      // 拖拽期间关闭穿透（避免 mouseup 丢失）；坐标由渲染侧 pointermove 事件驱动（与 Linux 实现统一）
      capability.setClickThrough(false)
      dragOrigin = { start: cursor, bounds: win.getBounds() }
    },

    dragMove(cursor: Point) {
      if (isWindowMoveLocked()) return
      if (!dragOrigin) return
      const { start, bounds } = dragOrigin
      win.setBounds({
        x: Math.round(bounds.x + (cursor.x - start.x)),
        y: Math.round(bounds.y + (cursor.y - start.y)),
        width: bounds.width,
        height: bounds.height
      })
    },

    endDrag() {
      if (!dragOrigin) return
      dragOrigin = null
    },

    setScale(scale: number) {
      const b = win.getBounds()
      const width = Math.round(opts.width * scale)
      const height = Math.round(opts.height * scale)
      win.setBounds({
        x: Math.round(b.x + (b.width - width) / 2),
        y: Math.round(b.y + (b.height - height) / 2),
        width,
        height
      })
    },

    getWorkArea(): Rect {
      return screen.getDisplayMatching(win.getBounds()).workArea
    },

    // P3 自主行为引擎：缓动移动（单次 IPC 一次移动；完成/取消 resolve）
    moveTo: (x, y, durationMs) => mover.moveTo(x, y, durationMs),
    cancelMove: () => mover.cancelMove(),
    getGeometry: () => readGeometry(win)

    // setInteractiveRects 不实现：Windows 上 forward 有保证，渲染侧 mousemove 检测即可
  }

  capability.setClickThrough(true)

  return {
    window: win,
    capability,
    degraded: false
  }
}
