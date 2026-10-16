/**
 * 教学域几何（expandedBounds 宽度记忆夹取 / podiumPoint "板书左下角"讲台位）——离线自测
 * （纯函数，不依赖 Electron 运行时）。
 *
 * 运行方式：cd frontend && npm run test:teaching-geometry
 *
 * 覆盖（2026-10-16 用户定稿需求）：
 *   expandedBounds：默认比例宽度 / widthOverride（拖宽记忆）生效 / 下限夹取（BOARD_MIN_WIDTH）/
 *     上限夹取（工作区宽 − 右距）/ 各形态右缘对齐；
 *   podiumPoint：宠物窗右缘与黑板左缘恒定留 PODIUM_GAP 小缝 / 底部与黑板底平齐 /
 *     黑板拖宽（左缘移动）后跟随关系守恒。
 */
import {
  BOARD_MARGIN_RIGHT,
  BOARD_MIN_WIDTH,
  PODIUM_FOOT_LINE_Y,
  PODIUM_GAP,
  PODIUM_IMG_RIGHT_INSET,
  PODIUM_PET_SIZE,
  expandedBounds,
  podiumPoint
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

const wide = expandedBounds(WA, 1200)
check('widthOverride=1200 生效（拖宽记忆）', wide.width === 1200, `got=${wide.width}`)
check('拖宽后右缘仍对齐', wide.x + wide.width === WA.x + WA.width - BOARD_MARGIN_RIGHT)

const clampedMax = expandedBounds(WA, 99999)
check('上限夹取 = 工作区宽 − 右距', clampedMax.width === WA.width - BOARD_MARGIN_RIGHT, `got=${clampedMax.width}`)

const clampedMin = expandedBounds(WA, 10)
check('下限夹取 = BOARD_MIN_WIDTH', clampedMin.width === BOARD_MIN_WIDTH, `got=${clampedMin.width}`)

const smallWa: Rect = { x: 0, y: 0, width: 600, height: 1080 }
const small = expandedBounds(smallWa, 999)
check('小工作区上限仍不越界（宽−右距）', small.width === smallWa.width - BOARD_MARGIN_RIGHT, `got=${small.width}`)
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

console.log(`\n=== teaching geometry 离线测试：${pass} 通过 / ${failures.length} 失败 ===`)
if (failures.length > 0) {
  failures.forEach((f) => console.error(`  ✗ ${f}`))
  process.exit(1)
}
