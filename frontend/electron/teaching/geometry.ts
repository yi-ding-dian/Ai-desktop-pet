/**
 * 教学模式（P5，设计文档 §7.5）几何计算——**纯函数**，不依赖 Electron 运行时。
 *
 * 黑板窗口与讲台位的所有空间参数集中在此处：调观感/占屏比例只改这个文件。
 * 坐标一律为屏幕 DIP 坐标（workArea 由 electron/teaching/index.ts 经 screen 查询后传入）。
 *
 * 形态速览（以宠物窗口所在显示器的工作区 wa 为基准）：
 *   展开态：宽 = min(round(wa.width × 55%), 1000)，高 = wa.height − 120，右距 20，垂直居中；
 *   拖拽态（2026-10-18）：四边/四角可拖改尺寸（只动被拖的边），标题栏可拖移位；
 *   折叠态：24 × 140 贴右缘（右距 8），垂直居中；
 *   屏外态：整窗落在 wa 右缘之外（滑入起点 / 滑出终点）；
 *   讲台位：宠物窗口（280×300）到工作区左下角——左距 40、下距 40。
 */
import { petWindowSize, type Point, type Rect, type Size } from '../window'
import {
  clampFramelessRect,
  moveFramelessRect,
  resizeFramelessRect,
  type FramelessResizeTarget,
  type FramelessSizeLimits
} from '../window/frameless-geometry'

/** 展开态：宽 = 工作区宽 × 本比例（再受 BOARD_MAX_WIDTH 夹取；拖宽记忆值优先，仍受夹取） */
export const BOARD_WIDTH_RATIO = 0.55
/** 展开态：宽度上限（px；默认形态用——拖宽上限另按工作区实算） */
export const BOARD_MAX_WIDTH = 1000
/** 展开态/拖拽：宽度下限（px）——太窄看不了板书（2026-10-18 四边可拖后仍保留） */
export const BOARD_MIN_WIDTH = 500
/** 拖拽：高度下限（px）——保住顶栏 + 至少几行板书 + 输入条 */
export const BOARD_MIN_HEIGHT = 300
/** 拖拽：黑板任一边与工作区边缘的最小留白（px；拖出屏幕后仍能抓回来） */
export const BOARD_EDGE_MARGIN = 10
/** 展开态：高度 = 工作区高 − 本值（上下各留白的合计语义，见 §7.5.2） */
export const BOARD_HEIGHT_INSET = 120
/** 展开态：距工作区右缘（px） */
export const BOARD_MARGIN_RIGHT = 20
/** 折叠态（右缘小角标）尺寸（px） */
export const BOARD_FOLDED_WIDTH = 24
export const BOARD_FOLDED_HEIGHT = 140
/** 折叠态：距工作区右缘（px；贴边） */
export const BOARD_FOLDED_MARGIN_RIGHT = 8
/** 讲台位：宠物窗口逻辑尺寸（1.0x 基准；运行时用 podiumPetSize(scale)） */
export const PODIUM_PET_SIZE = 270
export const PODIUM_PET_HEIGHT = 240
/** 讲台位：兔子**图像**右缘距窗口右缘的窗内偏移（px，1.0x 基准）——宽度 270 时视觉范围约 x 15–270 */
export const PODIUM_IMG_RIGHT_INSET = 0
/**
 * 讲台位：兔子**图像**右缘与黑板左缘之间的小缝（px；2026-10-16 用户两轮截图定稿"再近一点"：
 * 按图像边界贴板——窗口右缘会与黑板轻微重叠 ~57px，重叠区为透明+空气让路自动穿透，无碍）。
 */
export const PODIUM_GAP = 8
/**
 * 讲台位：兔子图像"脚底线"在窗口内的 y（px）。窗底贴黑板底时脚会悬空，故窗口 y 取
 * `黑板底 − 本值`，让**视觉上**脚底与黑板底平齐（2026-10-16 用户红框定稿"这里才对，位置"）。
 * 取值依据（真机闭环反推）：黑板工作区高 1040（扣底栏）→ 板底 980；历史 bug 时兔子被
 * moveTo 夹在 y=680、脚=680+225=905，与截图的 ~75px 缺口自洽 → 脚线 225。
 * 换兔子形象/姿态时按同样方法校准（看 [teaching] 状态广播的 podium 值与板底之差）。
 */
export const PODIUM_FOOT_LINE_Y = 191

/** 讲台位窗口尺寸（随宠物缩放档位；教学期间禁止改档位，值保持稳定） */
export function podiumPetSize(scale = 1): Size {
  return petWindowSize(scale)
}

/** 讲台位视觉偏移随缩放档位派生（脚底线/图像右缘内缩） */
export function podiumFootLineY(scale = 1): number {
  return Math.round(PODIUM_FOOT_LINE_Y * scale)
}

/**
 * 展开态**默认**矩形（工作区 → 屏幕坐标；用户拖过的形态记忆由调用方优先，
 * 见 teaching/index.ts 的 currentExpandedBounds + clampBoardRect）。
 */
export function expandedBounds(wa: Rect): Rect {
  const base = Math.min(Math.round(wa.width * BOARD_WIDTH_RATIO), BOARD_MAX_WIDTH)
  const maxWidth = Math.max(BOARD_MIN_WIDTH, wa.width - BOARD_MARGIN_RIGHT)
  const width = Math.round(Math.min(Math.max(base, BOARD_MIN_WIDTH), maxWidth))
  const height = Math.max(1, wa.height - BOARD_HEIGHT_INSET)
  return {
    x: wa.x + wa.width - width - BOARD_MARGIN_RIGHT,
    y: wa.y + Math.round((wa.height - height) / 2),
    width,
    height
  }
}

/**
 * 黑板的尺寸/边距约束（通用拖动缩放引擎的板级绑定）。
 * 语义：只改被拖动的边、对边固定；不小于 500×300，任一边留 10px 在工作区内。
 * 具体几何实现在 `electron/window/frameless-geometry.ts`（所有无边框窗口共用；
 * fractional DPI 的"只信请求值"约定也在那里）。
 */
const BOARD_LIMITS: FramelessSizeLimits = {
  minWidth: BOARD_MIN_WIDTH,
  minHeight: BOARD_MIN_HEIGHT,
  edgeMargin: BOARD_EDGE_MARGIN
}

/** 黑板拖动改尺寸（四边/四角；薄包装，见 frameless-geometry.resizeFramelessRect） */
export function resizedBoardRect(
  cur: Rect,
  target: FramelessResizeTarget,
  wa: Rect
): Rect | null {
  return resizeFramelessRect(cur, target, wa, BOARD_LIMITS)
}

/** 平移后的黑板矩形（标题栏拖动；薄包装，见 frameless-geometry.moveFramelessRect） */
export function movedBoardRect(cur: Rect, dx: number, dy: number, wa: Rect): Rect | null {
  return moveFramelessRect(cur, dx, dy, wa, BOARD_LIMITS)
}

/** 把矩形夹进工作区（恢复形态记忆用；薄包装，见 frameless-geometry.clampFramelessRect） */
export function clampBoardRect(rect: Rect, wa: Rect): Rect {
  return clampFramelessRect(rect, wa, BOARD_LIMITS)
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

/**
 * 讲台位（宠物窗口左上角目标屏幕坐标；宠物窗口 400×400）：
 * **贴在黑板窗左下角外侧**——兔子**图像**右缘与黑板左缘留 PODIUM_GAP 小缝（按图像边界量，
 * 非窗口边界——2026-10-16 用户定稿"再近一点"）、**图像脚底**与黑板底平齐（用户红框定稿；
 * 替代原"工作区左下角"）。头顶消息列表与图像右缘同线（styles.css 的 right 定位——改则同步）。
 * @param board 黑板窗当前矩形（屏幕坐标）——黑板拖宽/移位后重算即得新讲台位
 */
export function podiumPoint(board: Rect, scale = 1): Point {
  const size = podiumPetSize(scale)
  const inset = Math.round(PODIUM_IMG_RIGHT_INSET * scale)
  return {
    x: board.x - (size.width - inset) - PODIUM_GAP,
    y: board.y + board.height - podiumFootLineY(scale)
  }
}
