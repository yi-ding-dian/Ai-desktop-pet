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
export const PET_VISUAL_INSET_X = 80
/** 与工作区边缘的最小边距（px） */
export const EDGE_MARGIN = 8
/** 完整面板最小/最大宽度（px）：头部“铃铛+提醒+时钟+计数”至少要 140，正文最多约 10 个汉字 */
export const MIN_PANEL_WIDTH = 140
export const MAX_PANEL_WIDTH = 220
/**
 * 完整面板最大高度（px；超出由列表内部滚动）。
 * 480 让时钟视图 7~9 条可一次看全（向下展开、可盖住输入框）；再高内部滚动。
 */
export const MAX_PANEL_HEIGHT = 480
/** 完整面板最小高度（px） */
export const MIN_PANEL_HEIGHT = 80
/** 紧凑条尺寸（px） */
export const COMPACT_WIDTH = 104
export const COMPACT_HEIGHT = 38
/** 常驻灰灯小条尺寸（px；无未读、只有待提醒时） */
export const BELL_ONLY_WIDTH = 104
export const BELL_ONLY_HEIGHT = 38
/** 灰灯小条中心距输入框顶边的高度（px；用户截图箭头高度：兔子下半身） */
export const BELL_ONLY_CENTER_ABOVE_INPUT = 60
/** 紧凑条判定：某一侧至少要有完整面板最小宽度才尝试完整面板 */
const FULL_MIN_SPACE = 140
/**
 * 聊天输入框顶边在宠物窗内的 y（px）：styles.css 的 .chat-panel bottom 0 + 输入行高 32，
 * 240 - 0 - 32 = 208。列表"踩着输入框上面"——底边固定在它上方。
 * 改聊天面板位置/高度时同步这里。
 */
const PET_CHAT_INPUT_TOP_Y = 208
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
 * @param forceFull 紧凑条被点击展开时，即使空间不足也尽量展开
 * @param anchorTop 非空 = **顶部固定、向下展开**（底部灰灯展开待提醒时）：
 *   以该屏幕 y 为面板顶边，高度向下生长（可越过输入框顶边，由用户点击别处收回）；
 *   null = 正常模式（底边踩在输入框上方，向上生长）
 */
export function computeReminderListPlacement(
  petBounds: Rect,
  content: Size,
  workArea: Rect,
  forceFull = false,
  anchorTop: number | null = null,
  scale = 1
): ReminderListPlacement {
  // 视觉偏移随宠物缩放派生（2026-10-21）：兔子轮廓等比缩放，UI 面板尺寸不缩放
  const visualInset = Math.round(PET_VISUAL_INSET_X * scale)
  const inputTopY = Math.round(PET_CHAT_INPUT_TOP_Y * scale)
  // 贴兔子视觉边缘（宠物窗左右各有透明留白），而不是窗边缘
  const visualLeft = petBounds.x + visualInset
  const visualRight = petBounds.x + petBounds.width - visualInset
  const rightSpace = workArea.x + workArea.width - visualRight - LIST_GAP - EDGE_MARGIN
  const leftSpace = visualLeft - workArea.x - LIST_GAP - EDGE_MARGIN

  const fullWidth = clamp(
    Math.round(content.width) || MIN_PANEL_WIDTH,
    MIN_PANEL_WIDTH,
    MAX_PANEL_WIDTH
  )
  // 列表底边固定"踩"在输入框上方；高度只能向上长，最多到工作区顶
  const bottom = petBounds.y + inputTopY - LIST_INPUT_GAP
  const heightLimit = Math.min(
    MAX_PANEL_HEIGHT,
    workArea.height - EDGE_MARGIN * 2,
    inputTopY - EDGE_MARGIN - LIST_INPUT_GAP
  )
  const fullHeight = clamp(
    Math.round(content.height) || MIN_PANEL_HEIGHT,
    Math.min(MIN_PANEL_HEIGHT, heightLimit),
    heightLimit
  )

  // 顶部固定、向下展开（灰灯展开待提醒）：不受“输入框顶边”限制，只夹进工作区。
  // 展开高度最多 MAX_PANEL_HEIGHT，内容超出由列表内部滚动。
  if (anchorTop !== null) {
    // 与灰灯/普通面板同一套选边：右侧放得下完整面板就右侧，否则左侧放得下就左侧
    const side: ReminderListSide =
      rightSpace >= FULL_MIN_SPACE
        ? 'right'
        : leftSpace >= FULL_MIN_SPACE
          ? 'left'
          : rightSpace >= leftSpace
            ? 'right'
            : 'left'
    const space = Math.max(72, side === 'right' ? rightSpace : leftSpace)
    const width = clamp(fullWidth, Math.min(MIN_PANEL_WIDTH, space), space)
    const expandedLimit = Math.min(
      MAX_PANEL_HEIGHT,
      workArea.height - EDGE_MARGIN * 2
    )
    const height = clamp(
      Math.round(content.height) || MIN_PANEL_HEIGHT,
      Math.min(MIN_PANEL_HEIGHT, expandedLimit),
      expandedLimit
    )
    const x =
      side === 'right'
        ? clamp(
            visualRight + LIST_GAP,
            workArea.x + EDGE_MARGIN,
            workArea.x + workArea.width - width - EDGE_MARGIN
          )
        : clamp(
            visualLeft - LIST_GAP - width,
            workArea.x + EDGE_MARGIN,
            workArea.x + workArea.width - width - EDGE_MARGIN
          )
    const y = clamp(
      anchorTop,
      workArea.y + EDGE_MARGIN,
      workArea.y + workArea.height - height - EDGE_MARGIN
    )
    return {
      x: Math.round(x),
      y: Math.round(y),
      width: Math.round(width),
      height,
      side,
      compact: false
    }
  }

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
  const compactBottom = petBounds.y + inputTopY - LIST_INPUT_GAP
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

/**
 * 常驻灰灯小条摆放（无未读、但有待提醒时）：
 * 右侧优先/左侧回退；垂直中心对齐用户截图的箭头高度（兔子下半身、
 * 输入框上方约 60px），不再贴输入框底边。尺寸固定，不参与面板宽度/高度夹取。
 * 点击后由宠物面切到 pendingExpanded，本函数让位给完整面板。
 */
export function computeReminderBellPlacement(
  petBounds: Rect,
  workArea: Rect,
  scale = 1
): ReminderListPlacement {
  const visualInset = Math.round(PET_VISUAL_INSET_X * scale)
  const inputTopY = Math.round(PET_CHAT_INPUT_TOP_Y * scale)
  const bellCenterAbove = Math.round(BELL_ONLY_CENTER_ABOVE_INPUT * scale)
  const visualLeft = petBounds.x + visualInset
  const visualRight = petBounds.x + petBounds.width - visualInset
  const rightSpace = workArea.x + workArea.width - visualRight - LIST_GAP - EDGE_MARGIN
  const leftSpace = visualLeft - workArea.x - LIST_GAP - EDGE_MARGIN
  // 与完整面板使用同一套选边标准（FULL_MIN_SPACE=140）：灰灯和面板永远同侧，
  // 不会出现“灰灯在右、点开后面板翻左”。右侧连完整面板都放不下时，灰灯也翻左。
  const side: ReminderListSide =
    rightSpace >= FULL_MIN_SPACE
      ? 'right'
      : leftSpace >= FULL_MIN_SPACE
        ? 'left'
        : rightSpace >= leftSpace
          ? 'right'
          : 'left'
  const width = Math.min(
    BELL_ONLY_WIDTH,
    Math.max(72, side === 'right' ? rightSpace : leftSpace)
  )
  const x =
    side === 'right'
      ? Math.min(
          visualRight + LIST_GAP,
          workArea.x + workArea.width - width - EDGE_MARGIN
        )
      : Math.max(workArea.x + EDGE_MARGIN, visualLeft - LIST_GAP - width)
  const centerY =
    petBounds.y + inputTopY - bellCenterAbove
  const y = clamp(
    centerY - BELL_ONLY_HEIGHT / 2,
    workArea.y + EDGE_MARGIN,
    workArea.y + workArea.height - BELL_ONLY_HEIGHT - EDGE_MARGIN
  )
  return {
    x: Math.round(x),
    y: Math.round(y),
    width: Math.round(width),
    height: BELL_ONLY_HEIGHT,
    side,
    compact: false
  }
}
