/** 工作窗的默认/折叠尺寸与窗口矩形动画（纯几何 + 不涉及业务状态）。 */
import { screen, type BrowserWindow } from 'electron'
import { applyFramelessBounds, framelessBounds } from '../window/frameless'
import type { Rect } from '../window'

/** 默认尺寸与最小尺寸（DIP） */
export const WORK_DEFAULT_WIDTH = 900
export const WORK_DEFAULT_HEIGHT = 780
export const WORK_MIN_WIDTH = 560
export const WORK_MIN_HEIGHT = 520
export const WORK_EDGE_MARGIN = 10

/**
 * 折叠角标（2026-10-20 用户需求"像板书那样吸附在窗口最右侧中间"）：
 * 尺寸/边距与教学黑板折叠态一致（24×140 贴屏幕右缘、垂直居中、右距 8）。
 */
export const WORK_FOLDED_WIDTH = 24
export const WORK_FOLDED_HEIGHT = 140
export const WORK_FOLDED_MARGIN_RIGHT = 8
/** 折叠/展开窗口动画时长（ms；同黑板展开⇄折叠的观感节奏） */
export const WORK_FOLD_DURATION_MS = 180
/** 动画帧间隔（ms，约 60fps） */
const ANIM_FRAME_MS = 16

export function defaultWorkRect(pet: BrowserWindow | null): Rect {
  // 跟随宠物所在显示器；宠物窗不可用时退回主屏
  const wa =
    pet !== null && !pet.isDestroyed()
      ? screen.getDisplayMatching(pet.getBounds()).workArea
      : screen.getPrimaryDisplay().workArea
  const width = Math.min(WORK_DEFAULT_WIDTH, Math.max(WORK_MIN_WIDTH, wa.width - 80))
  const height = Math.min(WORK_DEFAULT_HEIGHT, Math.max(WORK_MIN_HEIGHT, wa.height - 80))
  return {
    x: wa.x + wa.width - width - 40,
    y: wa.y + Math.round((wa.height - height) / 2),
    width,
    height
  }
}

/** 缓动：easeInOutQuad（与黑板折叠动画、宠物滑步同款的柔和起步/收尾） */
export function easeInOutQuad(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2
}

/** 逐帧缓动窗口矩形：走 applyFramelessBounds（程序化写，不污染用户形态记忆） */
export function animateWorkBounds(
  win: BrowserWindow,
  to: Rect,
  durationMs: number,
  isCurrent: () => boolean
): Promise<void> {
  const from = framelessBounds(win)
  const same =
    from.x === to.x && from.y === to.y && from.width === to.width && from.height === to.height
  if (durationMs <= 0 || same) {
    applyFramelessBounds(win, to)
    return Promise.resolve()
  }
  return new Promise((resolve) => {
    const t0 = Date.now()
    const timer = setInterval(() => {
      if (win.isDestroyed() || !isCurrent()) {
        clearInterval(timer)
        resolve()
        return
      }
      const p = Math.min(1, (Date.now() - t0) / durationMs)
      const e = easeInOutQuad(p)
      applyFramelessBounds(win, {
        x: Math.round(from.x + (to.x - from.x) * e),
        y: Math.round(from.y + (to.y - from.y) * e),
        width: Math.round(from.width + (to.width - from.width) * e),
        height: Math.round(from.height + (to.height - from.height) * e)
      })
      if (p >= 1) {
        clearInterval(timer)
        resolve()
      }
    }, ANIM_FRAME_MS)
  })
}

/** 折叠角标矩形：工作区右缘、垂直居中（参数与教学黑板 foldedBounds 一致） */
export function foldedWorkBounds(wa: Rect): Rect {
  return {
    x: wa.x + wa.width - WORK_FOLDED_WIDTH - WORK_FOLDED_MARGIN_RIGHT,
    y: wa.y + Math.round((wa.height - WORK_FOLDED_HEIGHT) / 2),
    width: WORK_FOLDED_WIDTH,
    height: WORK_FOLDED_HEIGHT
  }
}

/** 展开矩形夹进工作区（换显示器/窗口曾被拖出屏时兜底） */
export function clampWorkRect(rect: Rect, wa: Rect): Rect {
  const width = Math.min(Math.max(rect.width, WORK_MIN_WIDTH), wa.width)
  const height = Math.min(Math.max(rect.height, WORK_MIN_HEIGHT), wa.height)
  return {
    x: Math.min(Math.max(rect.x, wa.x), wa.x + wa.width - width),
    y: Math.min(Math.max(rect.y, wa.y), wa.y + wa.height - height),
    width,
    height
  }
}
