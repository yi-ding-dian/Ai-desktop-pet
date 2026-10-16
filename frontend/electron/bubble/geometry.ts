/**
 * 气泡窗定位几何（纯函数，无 electron 运行时依赖——便于推理与将来单测）。
 *
 * 坐标系：屏幕 DIP（与 Electron Rectangle 一致）。锚点 anchor = 气泡尾巴尖应指向的屏幕点
 * （宠物窗位置 + 兔子头部偏移算出，见 index.ts 的 HEAD_ANCHOR_OFFSET）。
 *
 * 摆放策略（防出屏）：
 *  - 横向：窗左缘 = 锚点 x - 尾尖内缩（tailInsetX），再夹进工作区（超屏时内收，
 *    尾巴随之不再严格对准锚点——可接受的降级）；
 *  - 纵向：优先后上（tail='down'，气泡悬于锚点上方，尾巴朝下指向宠物）；
 *    上方放不下 → 翻向（tail='up'，气泡落到锚点下方，尾巴朝上）；
 *    两侧都放不下（锚点贴边 + 大窗）→ 选空间较大的一侧并把窗口夹进工作区。
 *
 * 与渲染侧（src/bubble/bubble.css）的对齐约定：
 *  - tailInsetX / tailInsetY 必须与 bubble.css 中"尾尖在窗内的位置"（stage 留白 + 尾巴偏移）
 *    保持一致，否则尾巴视觉上对不准锚点；改样式留白时同步改这里的常量。
 */
import type { Point, Rect, Size } from '../window'

/**
 * 尾尖在窗内的位置（px）——必须与渲染侧对齐（两处约定，改则同步）：
 *  - TAIL_INSET_X：尾尖距窗左缘的水平距离 = bubble.css 的 stage 左留白（32）+ 尾巴方块水平偏移（12+4）；
 *  - TAIL_INSET_Y_DOWN：tail=down 时尾尖距窗**下缘** = stage 下留白（12）- 尾巴外伸量（~4）；
 *  - TAIL_INSET_Y_UP：tail=up 时尾尖距窗**上缘** = 说话气泡悬浮条区（28）+ stage 上留白（12）
 *    - 尾巴外伸量（~4）——条区加在窗顶（PetBubble 的 PAD.top=40 对所有形态生效：说话气泡悬浮
 *    工具条占顶部 28px，菜单/确认同布局保持对齐一致）。
 */
export const TAIL_INSET_X = 48
export const TAIL_INSET_Y_DOWN = 8
export const TAIL_INSET_Y_UP = 36
/** 尾巴尖与锚点之间的垂直间隙（px；留一点缝，尾巴"指"向锚点而不贴合） */
export const TAIL_GAP = 2
/** 窗口与工作区边缘的最小边距（px） */
export const EDGE_MARGIN = 4

/** 摆放结果：窗口左上角坐标 + 尾巴朝向（供 OPEN 载荷/SET_TAIL 下发） */
export interface BubblePlacement {
  x: number
  y: number
  tail: 'down' | 'up'
}

/** 数值夹取 */
function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi)
}

/**
 * 计算气泡窗摆放（窗口左上角 + 尾巴朝向）。
 * @param anchor   锚点（屏幕坐标；尾巴尖指向它）
 * @param size     气泡窗尺寸（含渲染侧留白；由渲染侧尺寸上报给出，首帧用预估值）
 * @param workArea 锚点所在显示器的工作区
 */
export function computeBubblePlacement(anchor: Point, size: Size, workArea: Rect): BubblePlacement {
  const w = Math.max(2, Math.round(size.width))
  const h = Math.max(2, Math.round(size.height))

  // 可用区间（含边距）；hi 可能小于 lo（工作区比窗还小）——用 max(lo, ...) 兜底保证 clamp 合法
  const minX = workArea.x + EDGE_MARGIN
  const maxX = workArea.x + workArea.width - w - EDGE_MARGIN
  const minY = workArea.y + EDGE_MARGIN
  const maxY = workArea.y + workArea.height - h - EDGE_MARGIN

  const x = clamp(anchor.x - TAIL_INSET_X, minX, Math.max(minX, maxX))

  // 纵向：先试后上（tail=down）。窗顶 += TAIL_INSET_Y - TAIL_GAP：让"窗内 tailInsetY 处的尾尖"
  // 恰好落在锚点上方 TAIL_GAP 处（尾尖 → 锚点的视觉连接由窗内布局承担，见文件头对齐约定）
  const above = Math.round(anchor.y + TAIL_INSET_Y_DOWN - TAIL_GAP - h)
  const below = Math.round(anchor.y - TAIL_INSET_Y_UP + TAIL_GAP)
  let y: number
  let tail: 'down' | 'up'
  if (above >= minY) {
    y = above
    tail = 'down'
  } else if (below <= maxY) {
    y = below
    tail = 'up'
  } else {
    // 两侧都放不下：选空间较大的一侧，再夹进工作区
    const spaceAbove = anchor.y - workArea.y
    const spaceBelow = workArea.y + workArea.height - anchor.y
    tail = spaceAbove >= spaceBelow ? 'down' : 'up'
    y = clamp(tail === 'down' ? above : below, minY, Math.max(minY, maxY))
  }
  return { x, y, tail }
}
