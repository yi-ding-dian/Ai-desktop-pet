/**
 * 无边框窗口拖动/缩放的纯几何（2026-10-18 窗口 UI 套件）——不依赖 Electron 运行时。
 *
 * 语义（与普通窗口一致）：只改**被拖动的边**，对边原地不动——
 *  - 拖左缘 → 右缘固定；拖右缘 → 左缘固定；
 *  - 拖上缘 → 下缘固定；拖下缘 → 上缘固定；
 *  - 角 = 同时拖两条边（如左上角 = 左 + 上）。
 * 尺寸不小于 minWidth×minHeight，且任何边都留 edgeMargin 在工作区内。
 *
 * 为什么统一在这里（fractional DPI 的教训，2026-10-18 真机 bug）：拖动中渲染侧每个
 * pointermove 都会上报一次目标尺寸，`cur` 必须是"最近一次**请求**的 bounds"，
 * **不得传 getBounds()**——Windows 175% 缩放下 getBounds 会回吐舍入放大值（+1~2px），
 * 回喂会让每次事件再放大一次并累加：高度逐次变大，视觉上"按住边缘不动，窗口自己往下跑"。
 * 目标与当前一致时返回 null（调用方跳过 setBounds，断开反馈环）。
 *
 * 依赖方向：本文件属于窗口域（window/），被 window/frameless.ts 与业务域（teaching）复用；
 * 不反向依赖业务域。
 */
import type { Rect } from './index'

/** 尺寸与边距约束 */
export interface FramelessSizeLimits {
  minWidth: number
  minHeight: number
  /** 任一边与工作区边缘的最小留白（px；默认 10——拖出屏幕后仍能抓回来） */
  edgeMargin?: number
}

/** 拖动改尺寸的目标：尺寸 + 拖动的边 */
export interface FramelessResizeTarget {
  width: number
  height: number
  left: boolean
  right: boolean
  top: boolean
  bottom: boolean
}

/** 数值夹取（lo > hi 时按 lo 处理，防止极端尺寸下上下界打架） */
function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), Math.max(lo, hi))
}

function marginOf(limits: FramelessSizeLimits): number {
  return limits.edgeMargin ?? 10
}

/**
 * 拖动改尺寸后的矩形（只动被拖的边）。
 * @param cur    窗口当前**请求**矩形（屏幕坐标；不得来自 getBounds 的舍入值）
 * @param target 渲染侧目标尺寸 + 拖动的边
 * @param wa     窗口所在显示器工作区
 */
export function resizeFramelessRect(
  cur: Rect,
  target: FramelessResizeTarget,
  wa: Rect,
  limits: FramelessSizeLimits
): Rect | null {
  const margin = marginOf(limits)
  const minX = wa.x + margin
  const maxRight = wa.x + wa.width - margin
  const minY = wa.y + margin
  const maxBottom = wa.y + wa.height - margin

  let { x, y, width, height } = cur

  // 左右只能拖一边（角也只组合上/下）；两边同时为 true 是不存在的输入，按"不动"处理
  if (target.left !== target.right) {
    if (target.left) {
      const right = cur.x + cur.width // 右缘固定
      width = Math.round(
        clamp(target.width, limits.minWidth, Math.max(limits.minWidth, right - minX))
      )
      x = right - width
    } else {
      // 右缘拖动：左缘固定
      width = Math.round(
        clamp(target.width, limits.minWidth, Math.max(limits.minWidth, maxRight - cur.x))
      )
      x = cur.x
    }
  }

  if (target.top !== target.bottom) {
    if (target.top) {
      const bottom = cur.y + cur.height // 下缘固定
      height = Math.round(
        clamp(target.height, limits.minHeight, Math.max(limits.minHeight, bottom - minY))
      )
      y = bottom - height
    } else {
      // 下缘拖动：上缘固定
      height = Math.round(
        clamp(target.height, limits.minHeight, Math.max(limits.minHeight, maxBottom - cur.y))
      )
      y = cur.y
    }
  }

  if (x === cur.x && y === cur.y && width === cur.width && height === cur.height) return null
  return { x, y, width, height }
}

/**
 * 平移后的矩形（标题栏拖动）：dx/dy 是相对手势起点的累计位移，整体夹进工作区。
 * 同位置/同尺寸返回 null（幂等，断开 feedback 环）。
 */
export function moveFramelessRect(
  cur: Rect,
  dx: number,
  dy: number,
  wa: Rect,
  limits: FramelessSizeLimits
): Rect | null {
  const next = clampFramelessRect(
    { ...cur, x: Math.round(cur.x + dx), y: Math.round(cur.y + dy) },
    wa,
    limits
  )
  const same =
    next.x === cur.x && next.y === cur.y && next.width === cur.width && next.height === cur.height
  return same ? null : next
}

/**
 * 把矩形夹进工作区（尺寸与位置都夹）：恢复记忆值时用（换屏/分辨率变化后仍可见）。
 * 尺寸先夹（不小于最小尺寸、不大于工作区可用区），再夹位置，保证整窗可见。
 */
export function clampFramelessRect(rect: Rect, wa: Rect, limits: FramelessSizeLimits): Rect {
  const margin = marginOf(limits)
  const minX = wa.x + margin
  const maxRight = wa.x + wa.width - margin
  const minY = wa.y + margin
  const maxBottom = wa.y + wa.height - margin

  const width = Math.round(
    clamp(rect.width, limits.minWidth, Math.max(limits.minWidth, maxRight - minX))
  )
  const height = Math.round(
    clamp(rect.height, limits.minHeight, Math.max(limits.minHeight, maxBottom - minY))
  )
  return {
    x: Math.round(clamp(rect.x, minX, Math.max(minX, maxRight - width))),
    y: Math.round(clamp(rect.y, minY, Math.max(minY, maxBottom - height))),
    width,
    height
  }
}
