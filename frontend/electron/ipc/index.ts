/**
 * IPC 域：把通道绑定到窗口能力实现。
 *
 * 依赖方向：ipc（协议层）→ window（平台能力），单向。
 * 渲染进程永远不直接操作窗口（设计文档 §1.1 核心原则 1），一律经由这里转发。
 */
import { ipcMain, powerMonitor, type BrowserWindow } from 'electron'
import { IPC, IPC_EVENTS, type WindowDebugState } from './channels'
import { backendManager } from '../backend-process'
import type { Point, Rect, WindowCapability } from '../window'

/** 窗口几何推送的 debounce 时长（ms）：拖拽/缓动期间大量 move 事件只推一次最终值 */
const GEOMETRY_PUSH_DEBOUNCE_MS = 1000

export interface IpcContext {
  capability: WindowCapability
  window: BrowserWindow
  /** 调试态：hitbox 边框显示开关（由 main 的调试快捷键维护） */
  getHitboxVisible(): boolean
}

/** 构建窗口调试状态快照 */
function buildDebugState(ctx: IpcContext): WindowDebugState {
  return {
    clickThrough: ctx.capability.isClickThrough(),
    alwaysOnTop: ctx.capability.isAlwaysOnTop(),
    hitboxVisible: ctx.getHitboxVisible()
  }
}

/** 主动向渲染进程推送调试状态（调试快捷键触发后调用） */
export function pushDebugState(ctx: IpcContext): void {
  ctx.window.webContents.send(IPC_EVENTS.WINDOW_DEBUG_STATE_CHANGED, buildDebugState(ctx))
}

/** 注册全部 IPC 处理器（主进程在窗口创建后调用一次） */
export function registerIpcHandlers(ctx: IpcContext): void {
  const { capability: cap } = ctx

  ipcMain.on(IPC.WINDOW_SET_CLICK_THROUGH, (_event, on: boolean) => {
    cap.setClickThrough(on)
  })

  ipcMain.on(IPC.WINDOW_DRAG_START, (_event, cursor: Point) => {
    cap.startDrag(cursor)
  })

  ipcMain.on(IPC.WINDOW_DRAG_MOVE, (_event, cursor: Point) => {
    cap.dragMove(cursor)
  })

  ipcMain.on(IPC.WINDOW_DRAG_END, () => {
    cap.endDrag()
  })

  ipcMain.on(IPC.WINDOW_REPORT_INTERACTIVE_RECTS, (_event, rects: Rect[]) => {
    // 可选能力：仅 Linux 实现（X11 形状穿透）
    cap.setInteractiveRects?.(rects)
  })

  ipcMain.handle(IPC.WINDOW_GET_DEBUG_STATE, () => buildDebugState(ctx))

  // P3 行为引擎：缓动移动（invoke 配对一次移动；完成/取消 resolve）
  ipcMain.handle(IPC.WINDOW_MOVE_TO, (_event, x: number, y: number, durationMs: number) =>
    cap.moveTo(x, y, durationMs)
  )
  ipcMain.on(IPC.WINDOW_MOVE_CANCEL, () => {
    cap.cancelMove()
  })
  ipcMain.handle(IPC.WINDOW_GET_GEOMETRY, () => cap.getGeometry())
  ipcMain.handle(IPC.SYSTEM_GET_IDLE_SECONDS, () => powerMonitor.getSystemIdleTime())

  // 窗口几何变化 → debounce 后推送（拖拽/缓动/系统移动统一收口，渲染侧据此上报 env_update）
  let geometryPushTimer: NodeJS.Timeout | null = null
  const scheduleGeometryPush = (): void => {
    if (geometryPushTimer) clearTimeout(geometryPushTimer)
    geometryPushTimer = setTimeout(() => {
      geometryPushTimer = null
      if (ctx.window.isDestroyed()) return
      ctx.window.webContents.send(IPC_EVENTS.WINDOW_GEOMETRY_CHANGED, cap.getGeometry())
    }, GEOMETRY_PUSH_DEBOUNCE_MS)
  }
  ctx.window.on('move', scheduleGeometryPush)
  ctx.window.on('resize', scheduleGeometryPush)

  // 后端状态快照：渲染进程晚于 ready 订阅时补状态（否则会漏掉一次性 ready 事件）
  ipcMain.handle(IPC.BACKEND_GET_SNAPSHOT, () => backendManager.getSnapshot())
}
