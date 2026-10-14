/**
 * IPC 通道定义（主进程 ↔ 渲染进程的单一事实来源）。
 *
 * 本文件只含常量与纯类型（不 import electron 运行时），preload / 渲染侧可安全引用。
 */
import type { Point, Rect } from '../window'

/** 通道名：渲染 → 主（send / invoke） */
export const IPC = {
  /** 设置点击穿透（boolean） */
  WINDOW_SET_CLICK_THROUGH: 'window:set-click-through',
  /** 开始拖拽（payload: Point，拖拽起始光标的屏幕坐标） */
  WINDOW_DRAG_START: 'window:drag-start',
  /** 拖拽移动（payload: Point，当前光标屏幕坐标；由渲染侧 pointer capture + pointermove 驱动） */
  WINDOW_DRAG_MOVE: 'window:drag-move',
  /** 结束拖拽 */
  WINDOW_DRAG_END: 'window:drag-end',
  /** 渲染侧上报窗口可交互矩形（payload: Rect[]，相对窗口左上角，DIP） */
  WINDOW_REPORT_INTERACTIVE_RECTS: 'window:report-interactive-rects',
  /** 查询窗口调试状态（invoke → WindowDebugState） */
  WINDOW_GET_DEBUG_STATE: 'window:get-debug-state',
  /** 查询后端状态快照（invoke → BackendSnapshot；渲染进程晚订阅时补状态） */
  BACKEND_GET_SNAPSHOT: 'backend:get-snapshot'
} as const

/** 通道名：主 → 渲染（webContents.send 广播） */
export const IPC_EVENTS = {
  /** 调试状态变化（调试快捷键触发后推送） */
  WINDOW_DEBUG_STATE_CHANGED: 'window:debug-state-changed',
  /** 后端子进程状态变化（payload: BackendStatusPayload） */
  BACKEND_STATUS_CHANGED: 'backend:status-changed',
  /** 后端就绪（payload: BackendReadyPayload，含 WS 端口与 hello token） */
  BACKEND_READY: 'backend:ready'
} as const

/** 后端子进程状态（设计文档 §5.2 状态机；IPC 广播取值） */
export type BackendState = 'starting' | 'ready' | 'failed' | 'stopped'

/** backend:status-changed 推送载荷（不含端口/token，连接信息只随 ready 事件下发） */
export interface BackendStatusPayload {
  state: BackendState
  /** 失败/重启等补充说明（供 UI 展示与排障） */
  message?: string
}

/** backend:ready 推送载荷：渲染侧据此建立 WS 连接（port + token） */
export interface BackendReadyPayload {
  port: number
  token: string
  pid: number
  /** 应用版本（app.getVersion()），hello.app_version 使用，与后端做版本握手 */
  appVersion: string
}

/** 后端状态快照（invoke backend:get-snapshot；覆盖渲染进程晚于 ready 订阅的场景） */
export interface BackendSnapshot extends BackendStatusPayload {
  port?: number
  token?: string
  pid?: number
  appVersion: string
}

/** 窗口调试状态快照（渲染侧状态栏展示） */
export interface WindowDebugState {
  clickThrough: boolean
  alwaysOnTop: boolean
  hitboxVisible: boolean
}

/**
 * preload 通过 contextBridge 暴露给渲染进程的白名单 API（window.pet）。
 * 渲染进程只能看到本接口，不得感知底层通道名与平台实现（设计文档 §1.1 核心原则 1）。
 */
export interface PetBridgeApi {
  /** 运行平台（'linux' | 'win32' | 'darwin' | ...），用于 UI 提示 */
  platform: string
  window: {
    /** 设置点击穿透 */
    setClickThrough(on: boolean): void
    /** 开始拖拽（参数为 pointerdown 事件的光标屏幕坐标） */
    startDrag(cursor: Point): void
    /** 拖拽移动（参数为 pointermove 事件的光标屏幕坐标） */
    dragMove(cursor: Point): void
    /** 结束拖拽 */
    endDrag(): void
    /** 上报窗口可交互矩形（宠物 hitbox 等；Linux 用作 X11 形状穿透的输入区） */
    reportInteractiveRects(rects: Rect[]): void
    /** 查询调试状态 */
    getDebugState(): Promise<WindowDebugState>
    /** 订阅调试状态变化；返回取消订阅函数 */
    onDebugStateChanged(cb: (state: WindowDebugState) => void): () => void
  }
  /** 后端子进程（设计文档 §5.2）：状态订阅 + 快照查询；渲染进程不直接管理进程 */
  backend: {
    /** 查询当前状态快照（含 ready 时的 port/token，用于渲染进程晚订阅的补状态） */
    getSnapshot(): Promise<BackendSnapshot>
    /** 订阅后端状态变化；返回取消订阅函数 */
    onStatusChanged(cb: (status: BackendStatusPayload) => void): () => void
    /** 订阅后端就绪（port + token 下发，渲染侧据此建立 WS 连接）；返回取消订阅函数 */
    onReady(cb: (payload: BackendReadyPayload) => void): () => void
  }
}
