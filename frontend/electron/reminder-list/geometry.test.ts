/**
 * 提醒列表窗几何（右侧优先 / 左侧回退 / 两侧都不够 → 紧凑条 / forceFull 展开）——离线自测。
 *
 * 运行方式：cd frontend && npm run test:reminder-list-geometry
 */
import {
  BELL_ONLY_CENTER_ABOVE_INPUT,
  BELL_ONLY_HEIGHT,
  BELL_ONLY_WIDTH,
  COMPACT_HEIGHT,
  COMPACT_WIDTH,
  EDGE_MARGIN,
  LIST_GAP,
  MAX_PANEL_HEIGHT,
  MIN_PANEL_WIDTH,
  PET_VISUAL_INSET_X,
  computeReminderBellPlacement,
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

// 7) 灰灯展开：顶部固定、向下生长（可越过输入框顶边）
{
  const collapsed = computeReminderListPlacement(PET, SIZE, WA)
  const expanded = computeReminderListPlacement(
    PET,
    { width: SIZE.width, height: 300 },
    WA,
    false,
    collapsed.y
  )
  check('灰灯展开 → 非紧凑', !expanded.compact)
  check('灰灯展开 → 顶部固定', expanded.y === collapsed.y)
  check('灰灯展开 → 高度用内容高度', expanded.height === 300)
  check(
    '灰灯展开 → 底边向下超过收起态',
    expanded.y + expanded.height > collapsed.y + collapsed.height
  )
  check(
    '灰灯展开 → 底部不越出工作区',
    expanded.y + expanded.height <= WA.y + WA.height - EDGE_MARGIN
  )
}

// 8) 灰灯展开的 anchorTop 越界时夹进工作区
{
  const p = computeReminderListPlacement(
    PET,
    { width: SIZE.width, height: 300 },
    WA,
    false,
    0
  )
  check('anchorTop 过小 → 夹到边距', p.y === WA.y + EDGE_MARGIN)
}

// 9) 常驻灰灯小条：右侧、固定尺寸、中心对齐箭头高度
{
  const p = computeReminderBellPlacement(PET, WA)
  check('灰灯 → 右侧', p.side === 'right')
  check('灰灯宽度固定', p.width === BELL_ONLY_WIDTH)
  check('灰灯高度固定', p.height === BELL_ONLY_HEIGHT)
  check(
    '灰灯贴兔子视觉右缘',
    p.x === PET.x + PET.width - PET_VISUAL_INSET_X + LIST_GAP
  )
  check(
    '灰灯中心在箭头高度（输入框上方 60px）',
    p.y + p.height / 2 === PET.y + 250 - BELL_ONLY_CENTER_ABOVE_INPUT
  )
  check('灰灯整体在输入框上方', p.y + p.height < PET.y + 250)
}

// 10) 灰灯靠右边缘时翻到左侧
{
  const pet = petAt(1600)
  const p = computeReminderBellPlacement(pet, WA)
  check('灰灯贴右缘 → 左侧', p.side === 'left')
  check(
    '灰灯左侧贴兔子视觉左缘',
    p.x === pet.x + PET_VISUAL_INSET_X - LIST_GAP - p.width
  )
}

// 11) 右侧比左侧窄、但右侧仍放得下完整面板 → 不翻左
{
  const pet = petAt(1300)
  const p = computeReminderBellPlacement(pet, WA)
  check('右侧更窄但放得下面板 → 仍右侧', p.side === 'right')
  check(
    '灰灯仍贴兔子视觉右缘',
    p.x === pet.x + PET.width - PET_VISUAL_INSET_X + LIST_GAP
  )
}

// 12) 右侧只够灰灯、不够完整面板 → 灰灯也翻左（与面板同侧）
{
  const pet = petAt(1524)
  const p = computeReminderBellPlacement(pet, WA)
  check('右侧放不下面板 → 灰灯也翻左', p.side === 'left')
}

if (failures.length > 0) {
  console.error(`\n${failures.length} 项失败：`)
  failures.forEach((item) => console.error(`  - ${item}`))
  process.exit(1)
}
console.log(`\n全部通过（${pass} 项）`)
