/**
 * 教学域几何（expandedBounds 宽度记忆夹取 / podiumPoint "板书左下角"讲台位）——离线自测
 * （纯函数，不依赖 Electron 运行时）。
 *
 * 运行方式：cd frontend && npm run test:teaching-geometry
 *
 * 覆盖：
 *   expandedBounds：默认比例宽度 / 各形态右缘对齐 / 小工作区下限夹取；
 *   podiumPoint：宠物窗右缘与黑板左缘恒定留 PODIUM_GAP 小缝 / 底部与黑板底平齐 /
 *     黑板拖宽（左缘移动）后跟随关系守恒；
 *   resizedBoardRect（2026-10-18 四边/四角拖拽）：只动被拖的边、对边固定、角同时两条边、
 *     最小尺寸与工作区边距夹取、重复同尺寸幂等（回归"按住边缘窗口自己往下跑"）；
 *   movedBoardRect / clampBoardRect：标题栏移位（累计位移、整窗夹回工作区、位移为 0 幂等）。
 */
import {
  BOARD_EDGE_MARGIN,
  BOARD_MARGIN_RIGHT,
  BOARD_MIN_HEIGHT,
  BOARD_MIN_WIDTH,
  PODIUM_FOOT_LINE_Y,
  PODIUM_GAP,
  PODIUM_IMG_RIGHT_INSET,
  PODIUM_PET_SIZE,
  clampBoardRect,
  expandedBounds,
  movedBoardRect,
  podiumPoint,
  resizedBoardRect
} from './geometry'
import type { Rect } from '../window'

let pass = 0
const failures: string[] = []

function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    pass += 1
    console.log(`  ✓ ${name}`)
  } else {
    failures.push(`${name}${detail ? `（${detail}）` : ''}`)
    console.error(`  ✗ ${name}${detail ? `（${detail}）` : ''}`)
  }
}

/** 标准工作区：黑板所在屏（1920×1080，副屏坐标） */
const WA: Rect = { x: 1920, y: 0, width: 1920, height: 1080 }

// ---------------------------------------------------------------- expandedBounds

const base = expandedBounds(WA)
check(
  '默认宽度 = min(55%, 1000)',
  base.width === Math.min(Math.round(WA.width * 0.55), 1000),
  `got=${base.width}`
)
check('默认右缘对齐（x+width = 工作区右 − 右距）', base.x + base.width === WA.x + WA.width - BOARD_MARGIN_RIGHT)

const smallWa: Rect = { x: 0, y: 0, width: 600, height: 1080 }
const small = expandedBounds(smallWa)
check('小工作区宽度夹到下限（不越界）', small.width === BOARD_MIN_WIDTH, `got=${small.width}`)
check('小工作区高度 = 工作区高 − 120', small.height === smallWa.height - 120, `got=${small.height}`)

// ---------------------------------------------------------------- podiumPoint

const board: Rect = { x: 2820, y: 60, width: 1000, height: 960 }
const p = podiumPoint(board)
check(
  '兔子图像右缘与黑板左缘恒留 PODIUM_GAP',
  board.x - (p.x + PODIUM_PET_SIZE - PODIUM_IMG_RIGHT_INSET) === PODIUM_GAP
)
check('兔子脚底线与黑板底平齐（视觉贴底）', p.y + PODIUM_FOOT_LINE_Y === board.y + board.height)

// 黑板左缘拖动后（左移 = 变宽）——讲台位应跟随（同一套关系守恒）
const dragged: Rect = { x: 2500, y: 60, width: 1320, height: 960 }
const p2 = podiumPoint(dragged)
check(
  '黑板拖宽后讲台位跟随（图像右缘贴新左缘）',
  dragged.x - (p2.x + PODIUM_PET_SIZE - PODIUM_IMG_RIGHT_INSET) === PODIUM_GAP
)
check('黑板拖宽后脚底线仍平齐', p2.y + PODIUM_FOOT_LINE_Y === dragged.y + dragged.height)
check('左移量 = 讲台位左移量（跟手语义）', p.x - p2.x === board.x - dragged.x)

// ---------------------------------------------------------------- resizedBoardRect（四边/四角拖拽改尺寸）

/** 只拖某几条边的载荷构造（宽度/高度对未拖的轴无意义，传什么都不会生效） */
function resize(
  cur: Rect,
  edges: { left?: boolean; right?: boolean; top?: boolean; bottom?: boolean },
  width = cur.width,
  height = cur.height
) {
  return resizedBoardRect(
    cur,
    {
      width,
      height,
      left: edges.left ?? false,
      right: edges.right ?? false,
      top: edges.top ?? false,
      bottom: edges.bottom ?? false
    },
    WA
  )
}

const before: Rect = { x: 2820, y: 60, width: 1000, height: 960 }

const widened = resize(before, { left: true }, 1200)
check('拖左缘：返回新矩形', widened !== null)
if (widened) {
  check('拖左缘：宽度 = 目标值', widened.width === 1200, `got=${widened.width}`)
  check('拖左缘：右缘固定', widened.x + widened.width === before.x + before.width)
  check('拖左缘：y/height 原样沿用', widened.y === before.y && widened.height === before.height)
}

const rightEdge = resize(before, { right: true }, 1005)
check('拖右缘：左缘固定', rightEdge?.x === before.x)
check('拖右缘：宽度 = 目标值', rightEdge?.width === 1005, `got=${rightEdge?.width}`)
const rightClamped = resize(before, { right: true }, 99999)
check(
  '拖右缘：右缘封顶 = 工作区右 − BOARD_EDGE_MARGIN',
  rightClamped !== null && rightClamped.x + rightClamped.width === WA.x + WA.width - BOARD_EDGE_MARGIN,
  `got=${rightClamped ? rightClamped.x + rightClamped.width : 'null'}`
)

const topEdge = resize(before, { top: true }, before.width, 800)
check('拖上缘：下缘固定', topEdge !== null && topEdge.y + topEdge.height === before.y + before.height)
check('拖上缘：高度 = 目标值', topEdge?.height === 800, `got=${topEdge?.height}`)

const bottomEdge = resize(before, { bottom: true }, before.width, 700)
check('拖下缘：上缘固定', bottomEdge?.y === before.y)
check('拖下缘：高度 = 目标值', bottomEdge?.height === 700)

const nwCorner = resize(before, { left: true, top: true }, 1100, 800)
check(
  '拖左上角：右缘、下缘同时固定',
  nwCorner !== null &&
    nwCorner.x + nwCorner.width === before.x + before.width &&
    nwCorner.y + nwCorner.height === before.y + before.height
)

const seCorner = resize(before, { right: true, bottom: true }, 1100, 800)
check(
  '拖右下角：左缘、上缘同时固定',
  seCorner !== null && seCorner.x === before.x && seCorner.y === before.y
)

check('尺寸未变返回 null（不 setBounds，断开反馈环）', resize(before, {}) === null)
check('尺寸下限 = BOARD_MIN_WIDTH', resize(before, { left: true }, 10)?.width === BOARD_MIN_WIDTH)
check('高度下限 = BOARD_MIN_HEIGHT', resize(before, { bottom: true }, before.width, 10)?.height === BOARD_MIN_HEIGHT)
check(
  '左缘不越出工作区（留 BOARD_EDGE_MARGIN）',
  resize(before, { left: true }, 99999)?.x === WA.x + BOARD_EDGE_MARGIN,
  `got=${resize(before, { left: true }, 99999)?.x}`
)

// 回归（2026-10-18 真机 bug）：按住边缘不动时 pointermove 重复上报同一目标尺寸——
// 第二次必须以第一次的**请求值**为 cur 返回 null，高度不得逐次变大
check(
  '重复同一目标尺寸 = 幂等（高度不增长、窗口不往下跑）',
  widened !== null && resize(widened, { left: true }, 1200) === null
)

// ---------------------------------------------------------------- movedBoardRect / clampBoardRect（标题栏移位）

const moved = movedBoardRect(before, -40, -20, WA)
check('拖动移位：x/y 按累计位移平移', moved?.x === before.x - 40 && moved?.y === before.y - 20)
check('拖动移位：尺寸不变', moved?.width === before.width && moved?.height === before.height)
check('位移为 0 返回 null（幂等，不断言 setBounds）', movedBoardRect(before, 0, 0, WA) === null)

const movedFar = movedBoardRect(before, 99999, 99999, WA)
check(
  '拖动移位：整窗夹进工作区（右/下留 BOARD_EDGE_MARGIN）',
  movedFar !== null &&
    movedFar.x + movedFar.width === WA.x + WA.width - BOARD_EDGE_MARGIN &&
    movedFar.y + movedFar.height === WA.y + WA.height - BOARD_EDGE_MARGIN,
  `got=${movedFar?.x},${movedFar?.y}`
)

const restored = clampBoardRect({ x: -500, y: -500, width: 200, height: 100 }, WA)
check(
  '恢复记忆：尺寸与位置都夹回工作区（最小尺寸 + 边距）',
  restored.x === WA.x + BOARD_EDGE_MARGIN &&
    restored.y === WA.y + BOARD_EDGE_MARGIN &&
    restored.width === BOARD_MIN_WIDTH &&
    restored.height === BOARD_MIN_HEIGHT,
  `got=${restored.x},${restored.y},${restored.width},${restored.height}`
)

console.log(`\n=== teaching geometry 离线测试：${pass} 通过 / ${failures.length} 失败 ===`)
if (failures.length > 0) {
  failures.forEach((f) => console.error(`  ✗ ${f}`))
  process.exit(1)
}
