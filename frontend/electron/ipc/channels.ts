/**
 * IPC 通道定义（主进程 ↔ 渲染进程的单一事实来源）。
 *
 * 本文件只含常量与纯类型（不 import electron 运行时），preload / 渲染侧可安全引用。
 */
import type { MoveResult, Point, Rect, WindowGeometry } from '../window'

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
  /** 缓动移动窗口到屏幕坐标（invoke (x, y, durationMs) → MoveResult；P3 行为引擎） */
  WINDOW_MOVE_TO: 'window:move-to',
  /** 取消进行中的缓动移动（无 payload） */
  WINDOW_MOVE_CANCEL: 'window:move-cancel',
  /** 查询窗口几何（invoke → WindowGeometry；行为执行 + env 上报用） */
  WINDOW_GET_GEOMETRY: 'window:get-geometry',
  /** 查询系统空闲秒数（invoke → number；powerMonitor.getSystemIdleTime） */
  SYSTEM_GET_IDLE_SECONDS: 'system:get-idle-seconds',
  /** 查询后端状态快照（invoke → BackendSnapshot；渲染进程晚订阅时补状态） */
  BACKEND_GET_SNAPSHOT: 'backend:get-snapshot'
} as const

/** 通道名：主 → 渲染（webContents.send 广播） */
export const IPC_EVENTS = {
  /** 调试状态变化（调试快捷键触发后推送） */
  WINDOW_DEBUG_STATE_CHANGED: 'window:debug-state-changed',
  /** 切换调试栏显隐（Ctrl+Shift+D 全局快捷键触发后推送；渲染侧翻转本地显隐状态） */
  WINDOW_TOGGLE_DEBUG_BAR: 'window:toggle-debug-bar',
  /** 窗口几何变化（移动/缩放后 debounce ~1s 推送；payload: WindowGeometry） */
  WINDOW_GEOMETRY_CHANGED: 'window:geometry-changed',
  /** 后端子进程状态变化（payload: BackendStatusPayload） */
  BACKEND_STATUS_CHANGED: 'backend:status-changed',
  /** 后端就绪（payload: BackendReadyPayload，含 WS 端口与 hello token） */
  BACKEND_READY: 'backend:ready',
  /** 魔法球动画：宠物遭到捕获/释放（payload: FxPetReactionPayload；只发宠物窗口，渲染侧播 captured/released 反应） */
  PET_FX_REACTION: 'pet:fx-reaction'
} as const

/** 通道名：魔法球捕获动画（fx 域：主进程 ↔ fx 动画页） */
export const IPC_FX = {
  /** fx 动画页 → 主：动画页已就绪（首帧可接收指令） */
  READY: 'fx:ready',
  /** 主 → fx 动画页：动画指令（payload: FxCommand，单通道多指令类型） */
  COMMAND: 'fx:command'
} as const

/**
 * fx 动画指令（主进程为指挥，fx 球窗页面只负责"画"；球固定在球窗中心，
 * 飞行 = 主进程移动球窗本身——指令不需要坐标，只有表现状态）。
 */
export type FxCommand =
  | { type: 'reset' }
  /** 进入飞行表现（拖尾/公转星点；cargo=true 时球内载宠物剪影——去程空载、回程携带） */
  | { type: 'flight'; cargo: boolean }
  /** 捕获爆闪：球心爆闪并吸附脉动（球窗原地停留 holdMs，期间宠物窗口缩小） */
  | { type: 'capture-burst'; holdMs: number }
  /** 释放爆闪：球炸开、光芒散开（显示方向） */
  | { type: 'release-burst' }
  /** 整层淡出（durationMs 后主进程隐藏球窗） */
  | { type: 'fade-out'; durationMs: number }

/** 宠物反应事件载荷（主 → 宠物窗口渲染进程） */
export interface FxPetReactionPayload {
  /** captured = 被魔法球抓住（隐藏动画）；released = 被放回原位（显示动画） */
  kind: 'captured' | 'released'
}

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
    /**
     * 订阅"调试栏显隐切换"事件（主进程 Ctrl+Shift+D 全局快捷键触发；渲染侧翻转本地显隐状态）；
     * 返回取消订阅函数
     */
    onToggleDebugBar(cb: () => void): () => void
    /** 缓动移动窗口到屏幕坐标 (x, y)；完成或被 cancelMove() 取消后 resolve（P3 行为引擎） */
    moveTo(x: number, y: number, durationMs: number): Promise<MoveResult>
    /** 取消进行中的缓动移动（用户交互打断行为时调用） */
    cancelMove(): void
    /** 查询窗口几何（位置/尺寸/工作区；行为执行与 env 上报用） */
    getGeometry(): Promise<WindowGeometry>
    /** 订阅窗口几何变化（主进程已 debounce ~1s）；返回取消订阅函数 */
    onGeometryChanged(cb: (geo: WindowGeometry) => void): () => void
  }
  /** 系统状态（env_update 上报依据） */
  system: {
    /** 系统空闲秒数（用户多久没有键鼠操作） */
    getIdleSeconds(): Promise<number>
  }
  /**
   * 魔法球捕获动画（fx 域）：
   *  - fx 动画页（fx.html）用 ready/onCommand 与主进程通信；
   *  - 宠物窗口用 onPetReaction 接收"被抓/被放"反应事件。
   */
  fx: {
    /** fx 动画页专用：通知主进程"动画页已就绪，可接收指令" */
    ready(): void
    /** fx 动画页专用：订阅主进程动画指令；返回取消订阅函数 */
    onCommand(cb: (cmd: FxCommand) => void): () => void
    /** 宠物窗口专用：订阅"被抓/被放"反应事件（隐藏/显示动画触发）；返回取消订阅函数 */
    onPetReaction(cb: (payload: FxPetReactionPayload) => void): () => void
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
