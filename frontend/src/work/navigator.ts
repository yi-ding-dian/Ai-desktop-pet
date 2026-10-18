/**
 * 右侧消息导航的纯几何（2026-10-18）。
 *
 * 输入：每条用户提问在滚动内容中的 offsetTop，以及内容总高/导航轨高度；
 * 输出：每个刻度在导航轨上的 top（0 起点）。滚动时用 activeTickId 取当前轮次。
 * 抽成纯函数便于离线测试（与 teaching/geometry、window/frameless-geometry 同风格）。
 */

export interface NavigatorAnchor {
  id: string
  /** 消息节点相对滚动内容顶部的偏移 */
  offsetTop: number
  height: number
}

export interface NavigatorTick {
  id: string
  /** 刻度在导航轨中的 top（px） */
  top: number
  /** 内容中的相对位置 0–1（hover 预览/调试用） */
  ratio: number
}

/** 刻度可视高度（px）；导航轨两端留出半个刻度，避免贴边被裁 */
export const NAVIGATOR_TICK_HEIGHT = 4
/** 内容顶部/底部各留的半个刻度空间 */
const NAVIGATOR_PADDING = NAVIGATOR_TICK_HEIGHT / 2

/**
 * 把消息锚点映射到导航轨坐标。
 * - contentHeight ≤ 0（尚未布局）：全部落在顶部；
 * - 结果夹在 [PADDING, railHeight - PADDING]，保证刻度完整可见。
 */
export function layoutTicks(
  anchors: readonly NavigatorAnchor[],
  contentHeight: number,
  railHeight: number
): NavigatorTick[] {
  const usableTop = NAVIGATOR_PADDING
  const usableBottom = Math.max(usableTop, railHeight - NAVIGATOR_PADDING)
  const usableHeight = usableBottom - usableTop
  return anchors.map((anchor) => {
    const ratio =
      contentHeight <= 0
        ? 0
        : Math.min(1, Math.max(0, anchor.offsetTop / contentHeight))
    return {
      id: anchor.id,
      top: Math.round(usableTop + ratio * usableHeight),
      ratio
    }
  })
}

/**
 * 当前高亮轮次：最后一个“内容位置已滚过判定线”的刻度。
 *
 * 注意：刻度 top 是导航轨坐标（0–railHeight），不能用内容像素的 scrollTop
 * 直接比较；这里先把 scrollTop 归一化成 0–1 的滚动比例，再与 tick.ratio 比。
 * threshold 让高亮略早于消息完全贴顶切换（更符合阅读直觉）。
 */
export function activeTickId(
  ticks: readonly NavigatorTick[],
  scrollTop: number,
  contentHeight: number,
  viewportHeight: number,
  threshold = 32
): string | null {
  // 内容不足一屏：不存在“滚动轮次”，固定为首条（避免阈值被极小的可滚动距离放大）
  if (contentHeight <= viewportHeight) return ticks[0]?.id ?? null
  const maxScroll = contentHeight - viewportHeight
  const scrollRatio = Math.min(1, Math.max(0, scrollTop / maxScroll))
  const thresholdRatio = threshold / maxScroll
  let active: string | null = ticks[0]?.id ?? null
  for (const tick of ticks) {
    if (tick.ratio <= scrollRatio + thresholdRatio) active = tick.id
    else break
  }
  return active
}
