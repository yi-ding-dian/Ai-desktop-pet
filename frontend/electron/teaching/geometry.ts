/**
 * 教学模式（P5，设计文档 §7.5）几何计算——**纯函数**，不依赖 Electron 运行时。
 *
 * 黑板窗口与讲台位的所有空间参数集中在此处：调观感/占屏比例只改这个文件。
 * 坐标一律为屏幕 DIP 坐标（workArea 由 electron/teaching/index.ts 经 screen 查询后传入）。
 *
 * 形态速览（以宠物窗口所在显示器的工作区 wa 为基准）：
 *   展开态：宽 = min(round(wa.width × 55%), 1000)，高 = wa.height − 120，右距 20，垂直居中；
 *   折叠态：24 × 140 贴右缘（右距 8），垂直居中；
 *   屏外态：整窗落在 wa 右缘之外（滑入起点 / 滑出终点）；
 *   讲台位：宠物窗口（400×400）到工作区左下角——左距 40、下距 40。
 */
import type { Point, Rect } from '../window'

/** 展开态：宽 = 工作区宽 × 本比例（再受 BOARD_MAX_WIDTH 夹取） */
export const BOARD_WIDTH_RATIO = 0.55
/** 展开态：宽度上限（px） */
export const BOARD_MAX_WIDTH = 1000
/** 展开态：高度 = 工作区高 − 本值（上下各留白的合计语义，见 §7.5.2） */
export const BOARD_HEIGHT_INSET = 120
/** 展开态：距工作区右缘（px） */
export const BOARD_MARGIN_RIGHT = 20
/** 折叠态（右缘小角标）尺寸（px） */
export const BOARD_FOLDED_WIDTH = 24
export const BOARD_FOLDED_HEIGHT = 140
/** 折叠态：距工作区右缘（px；贴边） */
export const BOARD_FOLDED_MARGIN_RIGHT = 8
/** 讲台位：宠物窗口逻辑尺寸（400×400）与距工作区左边/下边的边距（px） */
export const PODIUM_PET_SIZE = 400
export const PODIUM_MARGIN_LEFT = 40
export const PODIUM_MARGIN_BOTTOM = 40

/** 展开态矩形（工作区 → 屏幕坐标） */
export function expandedBounds(wa: Rect): Rect {
  const width = Math.min(Math.round(wa.width * BOARD_WIDTH_RATIO), BOARD_MAX_WIDTH)
  const height = Math.max(1, wa.height - BOARD_HEIGHT_INSET)
  return {
    x: wa.x + wa.width - width - BOARD_MARGIN_RIGHT,
    y: wa.y + Math.round((wa.height - height) / 2),
    width,
    height
  }
}

/** 折叠态矩形（右缘贴边小角标，垂直居中） */
export function foldedBounds(wa: Rect): Rect {
  return {
    x: wa.x + wa.width - BOARD_FOLDED_WIDTH - BOARD_FOLDED_MARGIN_RIGHT,
    y: wa.y + Math.round((wa.height - BOARD_FOLDED_HEIGHT) / 2),
    width: BOARD_FOLDED_WIDTH,
    height: BOARD_FOLDED_HEIGHT
  }
}

/**
 * 右缘屏外矩形：保持给定矩形的尺寸与 y，把 x 移到工作区右缘之外
 * （滑入动画起点 / 滑出动画终点；任何形态都可先跑到屏外再动画进出）。
 */
export function offscreenRight(wa: Rect, rect: Rect): Rect {
  return { x: wa.x + wa.width, y: rect.y, width: rect.width, height: rect.height }
}

/** 讲台位（宠物窗口左上角目标屏幕坐标；宠物窗口 400×400 → 工作区左下角） */
export function podiumPoint(wa: Rect): Point {
  return {
    x: wa.x + PODIUM_MARGIN_LEFT,
    y: wa.y + wa.height - PODIUM_PET_SIZE - PODIUM_MARGIN_BOTTOM
  }
}
