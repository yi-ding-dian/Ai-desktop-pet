/**
 * 提醒列表窗几何（右侧优先 / 左侧回退 / 两侧都不够 → 紧凑条 / forceFull 展开）——离线自测。
 *
 * 运行方式：cd frontend && npm run test:reminder-list-geometry
 */
import {
  COMPACT_HEIGHT,
  COMPACT_WIDTH,
  EDGE_MARGIN,
  LIST_GAP,
  MAX_PANEL_HEIGHT,
  MIN_PANEL_WIDTH,
  PET_VISUAL_INSET_X,
  computeReminderListPlacement
} from './geometry'
import type { Rect, Size } from '../window'

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

const WA: Rect = { x: 0, y: 0, width: 1920, height: 1080 }
const SIZE: Size = { width: 180, height: 220 }
const PET: Rect = { x: 700, y: 300, width: 400, height: 400 }

function petAt(x: number): Rect {
  return { ...PET, x }
}

// 1) 右侧优先
{
  const p = computeReminderListPlacement(PET, SIZE, WA)
  check('居中 → 右侧', p.side === 'right' && !p.compact)
  check(
    '右侧贴兔子视觉右缘 + 间隙',
    p.x === PET.x + PET.width - PET_VISUAL_INSET_X + LIST_GAP
  )
  check('宽度用内容宽度（未超上限）', p.width === SIZE.width)
}

// 2) 右侧贴边 → 翻左侧
{
  const pet = petAt(1600)
  const p = computeReminderListPlacement(pet, SIZE, WA)
  check('贴右缘 → 左侧', p.side === 'left' && !p.compact)
  check(
    '左侧贴兔子视觉左缘 - 间隙',
    p.x === pet.x + PET_VISUAL_INSET_X - LIST_GAP - p.width
  )
}

// 3) 两侧都不够 → 紧凑条
{
  const narrow: Rect = { x: 0, y: 0, width: 340, height: 800 }
  const pet = petAt(-30) // 视觉左/右两侧都 < FULL_MIN_SPACE（120）
  const p = computeReminderListPlacement(pet, SIZE, narrow)
  check('窄屏 → 紧凑条', p.compact)
  check('紧凑条高度固定', p.height === COMPACT_HEIGHT)
  check('紧凑条宽度不超过上限', p.width <= COMPACT_WIDTH)
  check('紧凑条在屏幕内', p.x >= narrow.x + EDGE_MARGIN && p.x + p.width <= narrow.x + narrow.width)
}

// 4) 紧凑条被点击 → forceFull 展开（即使空间不足也至少 140 宽）
{
  const narrow: Rect = { x: 0, y: 0, width: 340, height: 800 }
  const pet = petAt(-30)
  const p = computeReminderListPlacement(pet, SIZE, narrow, true)
  check('forceFull → 非紧凑', !p.compact)
  check('forceFull 最小宽度 140', p.width >= 140)
}

// 5) 垂直：贴工作区底部时夹取
{
  const low: Rect = { x: 0, y: 0, width: 1920, height: 800 }
  const pet: Rect = { x: 700, y: 620, width: 400, height: 400 }
  const p = computeReminderListPlacement(pet, { width: 280, height: 600 }, low)
  check('高度上限夹取', p.height <= Math.min(MAX_PANEL_HEIGHT, low.height - EDGE_MARGIN * 2))
  check('不越过工作区底部', p.y + p.height <= low.y + low.height - EDGE_MARGIN)
}

// 6) 最小宽度夹取
{
  const p = computeReminderListPlacement(PET, { width: 100, height: 100 }, WA)
  check('宽度不低于下限', p.width >= MIN_PANEL_WIDTH)
}

if (failures.length > 0) {
  console.error(`\n${failures.length} 项失败：`)
  failures.forEach((item) => console.error(`  - ${item}`))
  process.exit(1)
}
console.log(`\n全部通过（${pass} 项）`)
