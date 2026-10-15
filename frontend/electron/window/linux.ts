/**
 * Linux 窗口实现（设计文档 §5.1）。
 *
 * 会话适配：X11（当前环境实测）走全能力路径；Wayland 降级为不透明窗口（合成器不保证透明/穿透），
 * 引导用户以 XWayland 运行（--ozone-platform=x11）。
 *
 * X11 穿透与拖拽的实现说明（本项目实测结论，详见 frontend/verify-report.md）：
 *  1. setIgnoreMouseEvents(true, { forward: true }) 在 X11 上不会把 mousemove 转发给渲染进程
 *     → 「穿透默认开 + 渲染侧检测悬停」的原方案无法闭环，改用窗口形状 setShape 承担穿透：
 *     输入形状 = 宠物可交互矩形（hitbox），形状外的点击自然放行给桌面；
 *  2. setShape([]) 实测会让窗口输入区为空（彻底收不到任何事件）——"恢复全窗口"必须显式给全窗矩形；
 *  3. screen.getCursorScreenPoint() 为事件驱动缓存：光标离开窗口交互区后返回值冻结
 *     → 不能用于轮询或拖拽跟随，拖拽改为渲染侧 pointermove 事件驱动（见 startDrag/dragMove）。
 *
 * 窗口类型实验 type:'toolbar'（2026-10-15 实测，DDE + X11）：
 *  - 背景：DDE(Dock) 忽略 skipTaskbar——默认(NORMAL)类型下 Dock 会显示宠物窗口格
 *    （无 .desktop 时呈现为 fallback 图标），与"桌宠不应占 Dock 格子"的产品目标冲突；
 *  - 结论：**type:'toolbar' 有效**——设置后 Dock 中窗口格消失，且副作用全套复测无破坏：
 *    透明渲染（窗口背景仍透出桌面）、置顶（_NET_WM_STATE_ABOVE/STAYS_ON_TOP 正常，F10 可切换）、
 *    点击穿透（setShape 收缩/恢复，hitbox enter/leave 与 clickThrough 切换日志正常）、
 *    拖拽（窗口位置精确跟随光标）、F9/F10/F11 与 Ctrl+Shift+D 全局快捷键全部正常；
 *  - Wayland 会话：type 为 X11 概念（xdg-shell 无对应物），在 Wayland 下静默无效，
 *    不影响既有降级路径（degraded 分支照旧）。
 */
import { BrowserWindow, screen } from 'electron'
import type { PetWindowOptions, PlatformWindow, Point, Rect, WindowCapability } from './index'
import { createEasedMover, readGeometry } from './move'

/** X11 / Wayland 会话检测 */
function isWaylandSession(): boolean {
  return process.env.XDG_SESSION_TYPE === 'wayland' || Boolean(process.env.WAYLAND_DISPLAY)
}

export function createLinuxWindow(opts: PetWindowOptions): PlatformWindow {
  const degraded = isWaylandSession()
  if (degraded) {
    console.warn(
      '[window/linux] 检测到 Wayland 会话：降级为不透明窗口（透明/穿透不保证）。建议以 XWayland 启动：--ozone-platform=x11'
    )
  }

  const win = new BrowserWindow({
    width: opts.width,
    height: opts.height,
    // ---- 桌宠窗口基础形态（设计文档 §5.1）----
    transparent: !degraded,
    backgroundColor: degraded ? '#2b2b2b' : '#00000000',
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    // DDE(Dock) 忽略 skipTaskbar 属性，Dock 仍会显示窗口格（2026-10-15 实测）——
    // type:'toolbar' 实验结论见文件下方"窗口类型实验"注释块
    type: 'toolbar',
    resizable: false,
    hasShadow: false,
    show: false,
    webPreferences: {
      preload: opts.preload,
      contextIsolation: true,
      nodeIntegration: false,
      // 宠物动画持续渲染，禁用离屏节流
      backgroundThrottling: false
    }
  })

  // 初始位置：主屏工作区底部居中（桌宠站立位，留 48px 边距）
  const workArea = screen.getPrimaryDisplay().workArea
  win.setPosition(
    Math.round(workArea.x + (workArea.width - opts.width) / 2),
    Math.round(workArea.y + workArea.height - opts.height - 48)
  )

  /** 当前是否处于穿透态（true = 可交互区以外的鼠标事件放行给桌面） */
  let clickThrough = true
  /** 渲染侧上报的可交互矩形（相对窗口左上角，DIP）；形状穿透的依据 */
  let interactiveRects: Rect[] = []
  /** 拖拽会话：起始光标屏幕坐标 + 起始窗口 bounds */
  let dragOrigin: { start: Point; bounds: Rect } | null = null
  /** 缓动移动器（P3 行为引擎：walk 的窗口移动；与拖拽互斥由调用方保证） */
  const mover = createEasedMover(win)

  /** 全窗矩形（穿透关 / 可交互区未上报时的兜底形状） */
  const fullWindowRect = (): Rect => ({ x: 0, y: 0, width: opts.width, height: opts.height })

  /** 应用当前穿透态到窗口形状（X11 setShape；穿透开 = 收缩到可交互矩形，穿透关 = 全窗） */
  const applyShape = (): void => {
    const rects = clickThrough && interactiveRects.length > 0 ? interactiveRects : [fullWindowRect()]
    win.setShape(rects)
  }

  const capability: WindowCapability = {
    setClickThrough(on: boolean) {
      if (clickThrough === on) return
      clickThrough = on
      applyShape()
      console.log(`[window/linux] clickThrough -> ${on}`)
    },

    isClickThrough: () => clickThrough,

    setAlwaysOnTop(on: boolean) {
      win.setAlwaysOnTop(on)
      console.log(`[window/linux] alwaysOnTop -> ${on}`)
    },

    isAlwaysOnTop: () => win.isAlwaysOnTop(),

    startDrag(cursor: Point) {
      // 拖拽期间必须全窗接管：一是避免 mouseup 丢失，二是保证 pointermove 事件连续到达渲染进程
      capability.setClickThrough(false)
      dragOrigin = { start: cursor, bounds: win.getBounds() }
      console.log(`[window/linux] drag start @ ${cursor.x},${cursor.y}`)
    },

    dragMove(cursor: Point) {
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
      console.log('[window/linux] drag end')
    },

    setScale(scale: number) {
      // 以窗口中心为锚点等比缩放（宠物缩放的窗口侧实现）
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

    // X11 形状穿透：渲染侧上报宠物可交互矩形后应用（见 applyShape）
    setInteractiveRects(rects: Rect[]) {
      interactiveRects = rects
      applyShape()
    },

    // P3 自主行为引擎：缓动移动（单次 IPC 一次移动；完成/取消 resolve）
    moveTo: (x, y, durationMs) => mover.moveTo(x, y, durationMs),
    cancelMove: () => mover.cancelMove(),
    getGeometry: () => readGeometry(win)
  }

  // 启动即穿透：可交互矩形未上报前保持全窗形状（亚秒级瞬态），上报后立即收缩为宠物矩形
  console.log('[window/linux] clickThrough -> true（等待渲染侧上报可交互矩形）')

  return {
    window: win,
    capability,
    degraded
  }
}
