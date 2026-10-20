/**
 * 窗口能力统一接口（平台无关）。
 *
 * 设计文档 §5.1：对外只暴露本文件与 registry；业务代码（main.ts / ipc）不得 import 具体平台实现。
 *
 * 平台差异的归属（2026-10-16 明确，设计文档 §5.1 原话只提了本目录，现补全）：
 *  - **窗口域内部**的平台差异 → 本目录（`linux.ts` / `win32.ts` / `darwin.ts` + `registry.ts`）；
 *  - **跨域共用**的平台事实与常量 → `electron/platform/`（全项目唯一读 `process.platform` 之处）。
 * 新增平台时这两处就是完整的检查清单。注意本目录名是「窗口域」，与「Windows 平台」无关。
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

/** 窗口尺寸 */
export interface Size {
  width: number
  height: number
}

/**
 * 宠物窗设计尺寸（DIP）：固定尺寸窗口，创建、拖拽、自主移动与走位都必须使用这一组常量。
 *
 * **禁止把 `getBounds()` 的宽高回喂 `setBounds()`**：Windows fractional DPI（本机 175%）下
 * `setBounds(400×400)` 之后 `getBounds()` 会回吐 401×401，再拿 401 去 set 又变 402……
 * 每次交互/移动累积 +1px。宠物窗是 top 锚定兔子、bottom 锚定聊天输入框，窗口越撑越高
 * 会让输入框逐次下沉且回不去（2026-10-17 用户反馈"点兔头输入框越来越下面"）。
 * 与气泡窗的 `followSize` 契约同源（见 electron/bubble/geometry.ts）。
 * 魔法球动画的 `setScale` 是唯一允许临时改尺寸的路径（动画期间移动锁已挡住拖拽/moveTo）。
 */
export const PET_WINDOW_SIZE: Size = { width: 270, height: 240 }

/**
 * 宠物窗初始落点边距（DIP；2026-10-18 用户定稿）。
 * 初始位置 = 主屏工作区**右下角**（用户截图标记约在屏幕右侧 ~80%、底部）：
 * 启动演出从屏幕上方弧线飞入后落在这里；右缘留 150px 避开托盘/桌面小组件，
 * 底部沿用 48px 站立边距。三平台共用本函数——初始位置是产品行为，不应随平台漂移。
 */
export const PET_INITIAL_MARGIN_RIGHT = 150
export const PET_INITIAL_MARGIN_BOTTOM = 48

/** 计算宠物窗初始落点（主屏工作区右下角；窗口实现共用） */
export function initialPetPosition(workArea: Rect, size: Size): Point {
  return {
    x: Math.round(workArea.x + workArea.width - size.width - PET_INITIAL_MARGIN_RIGHT),
    y: Math.round(workArea.y + workArea.height - size.height - PET_INITIAL_MARGIN_BOTTOM)
  }
}

/** 窗口几何快照（屏幕坐标，DIP）：位置 + 尺寸 + 所在显示器工作区 */
export interface WindowGeometry {
  pos: Point
  size: Size
  workArea: Rect
}

/** 缓动移动结果（moveTo 的返回值） */
export interface MoveResult {
  /** 实际落点（被工作区 clamp / 中途取消后的真实位置） */
  x: number
  y: number
  /** false = 被 cancelMove() 取消（未达目标，通常来自用户交互打断） */
  completed: boolean
}

/**
 * 窗口能力接口（设计文档 §5.1 定义的统一能力）。
 * 说明：相比设计文档扩展了 dragMove()/endDrag()（拖拽需持续坐标输入与成对结束）
 *      与 isClickThrough()/isAlwaysOnTop()（调试状态查询）；
 *       moveTo()/cancelMove()/getGeometry() 为 P3 自主行为引擎新增（行为执行 + env 上报）。
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
  /**
   * 缓动移动窗口到屏幕坐标 (x, y)（P3 自主行为引擎：单次 IPC 一次移动，
   * 主进程内部逐帧 setBounds + 缓动曲线；完成或被 cancelMove() 取消后 resolve；
   * 目标点会 clamp 到所在显示器工作区内，实际落点以返回值为准）。
   */
  moveTo(x: number, y: number, durationMs: number): Promise<MoveResult>
  /** 取消进行中的缓动移动（若有）；其 moveTo 会以 completed:false resolve。无移动时忽略 */
  cancelMove(): void
  /** 当前窗口几何（行为执行器计算走动目标 + env_update 上报用） */
  getGeometry(): WindowGeometry
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
