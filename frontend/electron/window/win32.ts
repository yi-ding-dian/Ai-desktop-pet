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
import { initialPetPosition, type Size } from './index'
import type { PetWindowOptions, PlatformWindow, Point, Rect, WindowCapability } from './index'
import { createEasedMover, readGeometry } from './move'
import { isWindowMoveLocked } from './move-lock'
import { resolveAppIconImage } from '../app-icon'

export function createWin32Window(opts: PetWindowOptions): PlatformWindow {
  const win = new BrowserWindow({
    width: opts.width,
    height: opts.height,
    // 窗口/任务栏图标：与托盘、通知共用 build/icon.png（开发态 DDE 默认给 Electron 图标）
    icon: resolveAppIconImage(),
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

  // 初始位置：主屏工作区右下角（启动演出从屏幕上方弧线飞入后的落点，2026-10-18）
  const pos = initialPetPosition(screen.getPrimaryDisplay().workArea, {
    width: opts.width,
    height: opts.height
  })
  win.setPosition(pos.x, pos.y)

  let clickThrough = false
  let dragOrigin: { start: Point; bounds: Rect } | null = null
  /** 当前窗口尺寸（宠物缩放档位可调；拖拽/缓动移动都必须取它，不能写死基准值） */
  let currentSize: Size = { width: opts.width, height: opts.height }
  /** 缓动移动器（P3 行为引擎：walk 的窗口移动） */
  const mover = createEasedMover(win, () => currentSize)

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
      // 只取快照的 x/y；尺寸必须用设计常量——getBounds() 在 fractional DPI 下回吐的是
      // 舍入后的值（400→401→402…），回喂 setBounds 会让每次点击/拖动把窗口撑大 1px。
      // 宠物窗 top 锚定兔子、bottom 锚定聊天输入框，窗口变高看起来就是输入框逐次下沉。
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

    // setInteractiveRects 不实现：Windows 上 forward 有保证，渲染侧 mousemove 检测即可
  }

  capability.setClickThrough(true)

  return {
    window: win,
    capability,
    degraded: false
  }
}
