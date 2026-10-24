/** 窗口 / 无边框 / 缩放相关载荷。 */

/**
 * 宠物窗贴边状态（2026-10-20，主进程实时判定后推给渲染进程）：
 * - top：窗口顶边贴近工作区顶边（**优先级最高**，角落同时贴顶/贴边时取 top）；
 * - left / right：窗口左/右边贴近工作区左/右边（优先级高于 bottom）；
 * - bottom：窗口底边贴近工作区底边（2026-10-20：趴睡贴底，优先级最低）；
 * - none：未贴边（恢复站姿）。
 */
export type PetWindowEdge = 'none' | 'top' | 'left' | 'right' | 'bottom'

/**
 * 贴边状态事件载荷（2026-10-20）：
 * - edge：边缘动作方向（底部预挂阶段也是 bottom）；
 * - near：窗口是否已真正贴住工作区边（≤8px）。底部预挂只让宠物跟着窗口底走，
 *   near=false 时**不出光带、不吸附**；真正贴底 near=true 才提示并允许吸附。
 */
export interface WindowEdgePayload {
  edge: PetWindowEdge
  near: boolean
}

/**
 * 宠物缩放应用结果（主进程 → 渲染进程）：
 * - ok=false + reason='busy'：教学/工作模式或魔法球动画中（动画逐帧 setBounds，此时改尺寸会抢窗口）；
 * - ok=false + reason='invalid'：不在支持档位（0.8/0.9/1.0/1.1/1.2）。
 */
export interface PetScaleApplyResult {
  ok: boolean
  reason?: 'busy' | 'invalid'
}

/**
 * 无边框窗口拖动移位（渲染 → 主）：start 时主进程快照窗口矩形，
 * move 携带**相对手势起点**的累计位移（每帧都是绝对值，不累积误差），end 收尾。
 */
export interface FramelessMovePayload {
  phase: 'start' | 'move' | 'end'
  /** 相对手势起点的累计位移（DIP）；phase=start/end 时可为 0 */
  dx: number
  dy: number
}

/**
 * 无边框窗口拖动改尺寸（渲染 → 主）：只改**拖动的边**，对边固定。
 * 渲染侧用 pointerdown 时的 innerWidth/innerHeight 加鼠标位移算出目标尺寸。
 */
export interface FramelessResizePayload {
  width: number
  height: number
  left: boolean
  right: boolean
  top: boolean
  bottom: boolean
}

/** 窗口调试状态快照（渲染侧状态栏展示） */
export interface WindowDebugState {
  clickThrough: boolean
  alwaysOnTop: boolean
  hitboxVisible: boolean
}
