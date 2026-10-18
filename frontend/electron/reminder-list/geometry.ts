/**
 * 提醒列表窗定位几何（纯函数，无 electron 运行时依赖——便于离线自测）。
 *
 * 摆放规则（2026-10-18 用户定稿）：
 *  1. 优先贴在宠物**右侧**；
 *  2. 右侧空间不足 → 翻到**左侧**；
 *  3. 两侧都不够放完整面板 → **紧凑条**（只显示"待看 N 条"），点击再展开；
 *  4. 垂直对齐兔子头部下方，整体夹进所在显示器工作区。
 *
 * 坐标系：屏幕 DIP（与 Electron Rectangle 一致）。
 */
import type { Rect, Size } from '../window'

/** 列表窗与**兔子视觉边缘**之间的间隙（px；宠物窗有透明留白，不能贴窗口边缘） */
export const LIST_GAP = 8
/**
 * 兔子视觉范围在宠物窗内的左右留白（px）：按用户截图红框反推（2026-10-18）——
 * 贴“实际兔子轮廓”而不是 App 的保守交互矩形（x 65–335 比兔子本体宽），否则列表离兔子太远。
 * 右侧目标：窗右缘往内 140px + 8px 间隙；左侧回退对称使用。
 */
export const PET_VISUAL_INSET_X = 140
/** 与工作区边缘的最小边距（px） */
export const EDGE_MARGIN = 8
/** 完整面板最小/最大宽度（px）：头部“铃铛+提醒+时钟+计数”至少要 140，正文最多约 10 个汉字 */
export const MIN_PANEL_WIDTH = 140
export const MAX_PANEL_WIDTH = 220
/** 完整面板最大高度（px；超出由列表内部滚动） */
export const MAX_PANEL_HEIGHT = 320
/** 完整面板最小高度（px） */
export const MIN_PANEL_HEIGHT = 80
/** 紧凑条尺寸（px） */
export const COMPACT_WIDTH = 104
export const COMPACT_HEIGHT = 38
/** 紧凑条判定：某一侧至少要有完整面板最小宽度才尝试完整面板 */
const FULL_MIN_SPACE = 140
/**
 * 聊天输入框顶边在宠物窗内的 y（px）：styles.css 的 .chat-panel bottom 118 + 输入行高 32，
 * 400 - 118 - 32 = 250。列表"踩着输入框上面"——底边固定在它上方。
 * 改聊天面板位置/高度时同步这里。
 */
const PET_CHAT_INPUT_TOP_Y = 250
/** 列表底边与输入框顶边之间的间隙（px）：踩着上面但不贴死 */
const LIST_INPUT_GAP = 12

export type ReminderListSide = 'right' | 'left'

export interface ReminderListPlacement {
  x: number
  y: number
  width: number
  height: number
  side: ReminderListSide
  /** true = 两侧空间不足，只显示紧凑条 */
  compact: boolean
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(Math.max(value, lo), Math.max(lo, hi))
}

/**
 * 计算提醒列表窗摆放。
 *
 * @param petBounds 宠物窗屏幕矩形
 * @param content   渲染侧上报的内容尺寸（首帧用预估值）
 * @param workArea  宠物所在显示器的工作区
 */
export function computeReminderListPlacement(
  petBounds: Rect,
  content: Size,
  workArea: Rect,
  forceFull = false
): ReminderListPlacement {
  // 贴兔子视觉边缘（宠物窗左右各有透明留白），而不是窗边缘
  const visualLeft = petBounds.x + PET_VISUAL_INSET_X
  const visualRight = petBounds.x + petBounds.width - PET_VISUAL_INSET_X
  const rightSpace = workArea.x + workArea.width - visualRight - LIST_GAP - EDGE_MARGIN
  const leftSpace = visualLeft - workArea.x - LIST_GAP - EDGE_MARGIN

  const fullWidth = clamp(
    Math.round(content.width) || MIN_PANEL_WIDTH,
    MIN_PANEL_WIDTH,
    MAX_PANEL_WIDTH
  )
  // 列表底边固定"踩"在输入框上方；高度只能向上长，最多到工作区顶
  const bottom = petBounds.y + PET_CHAT_INPUT_TOP_Y - LIST_INPUT_GAP
  const heightLimit = Math.min(
    MAX_PANEL_HEIGHT,
    workArea.height - EDGE_MARGIN * 2,
    PET_CHAT_INPUT_TOP_Y - EDGE_MARGIN - LIST_INPUT_GAP
  )
  const fullHeight = clamp(
    Math.round(content.height) || MIN_PANEL_HEIGHT,
    Math.min(MIN_PANEL_HEIGHT, heightLimit),
    heightLimit
  )

  const canFullRight = rightSpace >= FULL_MIN_SPACE
  const canFullLeft = leftSpace >= FULL_MIN_SPACE
  const compact = !forceFull && !canFullRight && !canFullLeft

  if (!compact) {
    const side: ReminderListSide = canFullRight ? 'right' : canFullLeft ? 'left' : rightSpace >= leftSpace ? 'right' : 'left'
    const space = side === 'right' ? rightSpace : leftSpace
    // forceFull（紧凑条被点击展开）时即使空间不足也尽量展开，最小 140px；可能贴近宠物/屏幕边缘
    const width = forceFull
      ? clamp(fullWidth, 140, Math.max(140, space))
      : Math.min(fullWidth, space)
    const height = fullHeight
    const x =
      side === 'right'
        ? forceFull
          ? clamp(visualRight + LIST_GAP, workArea.x + EDGE_MARGIN, workArea.x + workArea.width - width - EDGE_MARGIN)
          : visualRight + LIST_GAP
        : forceFull
          ? clamp(visualLeft - LIST_GAP - width, workArea.x + EDGE_MARGIN, workArea.x + workArea.width - width - EDGE_MARGIN)
          : visualLeft - LIST_GAP - width
    // 垂直：底边踩在输入框上方（随内容向上生长），再夹进工作区
    const y = clamp(
      bottom - height,
      workArea.y + EDGE_MARGIN,
      workArea.y + workArea.height - height - EDGE_MARGIN
    )
    return { x: Math.round(x), y: Math.round(y), width: Math.round(width), height, side, compact }
  }

  // 两侧都不够：紧凑条放空间较大的一侧（贴着工作区边缘，尽量不挡宠物）
  const side: ReminderListSide = rightSpace >= leftSpace ? 'right' : 'left'
  const width = Math.min(
    COMPACT_WIDTH,
    Math.max(72, side === 'right' ? rightSpace : leftSpace)
  )
  const x =
    side === 'right'
      ? Math.min(visualRight + LIST_GAP, workArea.x + workArea.width - width - EDGE_MARGIN)
      : Math.max(workArea.x + EDGE_MARGIN, visualLeft - LIST_GAP - width)
  const compactBottom = petBounds.y + PET_CHAT_INPUT_TOP_Y - LIST_INPUT_GAP
  const y = clamp(
    compactBottom - COMPACT_HEIGHT,
    workArea.y + EDGE_MARGIN,
    workArea.y + workArea.height - COMPACT_HEIGHT - EDGE_MARGIN
  )
  return {
    x: Math.round(x),
    y: Math.round(y),
    width: Math.round(width),
    height: COMPACT_HEIGHT,
    side,
    compact: true
  }
}
