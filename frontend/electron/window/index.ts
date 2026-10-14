/**
 * 窗口能力统一接口（平台无关）。
 *
 * 设计文档 §5.1：对外只暴露本文件与 registry；业务代码（main.ts / ipc）不得 import 具体平台实现，
 * 平台差异仅允许出现在 electron/window/ 目录内。
 */
import type { BrowserWindow } from 'electron'

/** 屏幕矩形（与 Electron Rectangle 对齐） */
export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/** 屏幕坐标点（DIP / CSS 像素空间，二者在 Electron 内一致） */
export interface Point {
  x: number
  y: number
}

/**
 * 窗口能力接口（设计文档 §5.1 定义的统一能力）。
 * 说明：相比设计文档扩展了 dragMove()/endDrag()（拖拽需持续坐标输入与成对结束）
 *      与 isClickThrough()/isAlwaysOnTop()（调试状态查询）。
 */
export interface WindowCapability {
  /** 点击穿透：true = 鼠标事件放行给桌面 */
  setClickThrough(on: boolean): void
  /** 当前是否处于穿透状态 */
  isClickThrough(): boolean
  /** 置顶开关 */
  setAlwaysOnTop(on: boolean): void
  /** 当前是否置顶 */
  isAlwaysOnTop(): boolean
  /**
   * 开始拖拽。cursor = 拖拽起始光标的屏幕坐标（渲染侧 pointerdown 的 screenX/screenY）。
   * 透明窗口禁用 -webkit-app-region，自绘拖拽由主进程 setBounds 实现。
   */
  startDrag(cursor: Point): void
  /** 拖拽移动：cursor = 当前光标屏幕坐标（渲染侧 pointermove 上报；pointer capture 保证窗口外也能收到） */
  dragMove(cursor: Point): void
  /** 结束拖拽 */
  endDrag(): void
  /** 宠物缩放：等比缩放窗口尺寸（中心为锚点） */
  setScale(scale: number): void
  /** 工作区（防拖出屏幕） */
  getWorkArea(): Rect
  /**
   * 可选能力：更新窗口的可交互区域（相对窗口左上角，DIP）。
   * Linux 用它实现 X11 形状穿透（形状外点击放行给桌面）；平台可不实现。
   */
  setInteractiveRects?(rects: Rect[]): void
}

/** 创建宠物窗口的入参 */
export interface PetWindowOptions {
  /** 窗口宽（默认逻辑基准 400） */
  width: number
  /** 窗口高 */
  height: number
  /** preload 脚本绝对路径 */
  preload: string
}

/** 平台实现产物：一个真实窗口 + 其能力操作集 */
export interface PlatformWindow {
  window: BrowserWindow
  capability: WindowCapability
  /** 该实现是否处于降级模式（如 Wayland / 未验证平台），供日志与 UI 提示 */
  degraded: boolean
}
