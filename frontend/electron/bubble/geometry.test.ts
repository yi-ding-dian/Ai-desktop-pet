/**
 * 气泡窗定位几何（computeBubblePlacement）——离线自测（纯函数，不依赖 Electron 运行时）。
 *
 * 运行方式（esbuild 打包后以 Node 执行）：
 *   cd frontend
 *   node_modules/.bin/esbuild electron/bubble/geometry.test.ts --bundle --platform=node --format=esm \
 *     --outfile=/tmp/bubble-geometry.test.mjs && node /tmp/bubble-geometry.test.mjs
 * （或 npm run test:bubble-geometry）
 *
 * 覆盖：常规放置（后上 tail=down、尾尖对准锚点上方 TAIL_GAP 处、横向对锚点）；
 *       上方贴边 → 翻向（tail=up、尾尖对准锚点下方）；两侧都放不下 → 选空间大侧 + clamp 进工作区；
 *       水平越界 clamp（内收）；工作区比窗还小 → 不崩且夹进工作区。
 */
import {
  computeBubblePlacement,
  EDGE_MARGIN,
  TAIL_GAP,
  TAIL_INSET_X,
  TAIL_INSET_Y
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

/** 标准工作区（1080p 全屏） */
const WA: Rect = { x: 0, y: 0, width: 1920, height: 1080 }
/** 菜单窗典型尺寸 */
const SIZE: Size = { width: 216, height: 200 }

/** 由摆放结果反推"尾尖"屏幕坐标（与渲染侧布局约定一致：tail=down 尾尖在窗左下区、up 在左上区） */
function tailPoint(p: { x: number; y: number; tail: 'down' | 'up' }): { x: number; y: number } {
  return {
    x: p.x + TAIL_INSET_X,
    y: p.tail === 'down' ? p.y + SIZE.height - TAIL_INSET_Y : p.y + TAIL_INSET_Y
  }
}

// ------------------------------------------------------------------ 用例

// 1. 常规：屏幕中央 → 气泡悬于锚点上方（tail=down），尾尖对准锚点上方 TAIL_GAP 处
{
  console.log('用例 1：常规放置（后上 tail=down，尾尖对准锚点）')
  const anchor = { x: 800, y: 500 }
  const p = computeBubblePlacement(anchor, SIZE, WA)
  check('tail=down', p.tail === 'down')
  const tp = tailPoint(p)
  check('尾尖 x 对准锚点', tp.x === anchor.x, `tail.x=${tp.x} anchor.x=${anchor.x}`)
  check('尾尖 y 在锚点上方 TAIL_GAP 处', tp.y === anchor.y - TAIL_GAP, `tail.y=${tp.y}`)
  check(
    '窗口整体在工作区内',
    p.x >= WA.x + EDGE_MARGIN &&
      p.y >= WA.y + EDGE_MARGIN &&
      p.x + SIZE.width <= WA.x + WA.width - EDGE_MARGIN &&
      p.y + SIZE.height <= WA.y + WA.height - EDGE_MARGIN
  )
}

// 2. 上方贴边 → 翻向（tail=up）：气泡落到锚点下方
{
  console.log('用例 2：上方空间不足 → 翻向 tail=up')
  const anchor = { x: 800, y: 60 } // 上方仅 60px，放不下 200 高的窗
  const p = computeBubblePlacement(anchor, SIZE, WA)
  check('tail=up', p.tail === 'up')
  const tp = tailPoint(p)
  check('尾尖 x 对准锚点', tp.x === anchor.x, `tail.x=${tp.x}`)
  check('尾尖 y 在锚点下方 TAIL_GAP 处', tp.y === anchor.y + TAIL_GAP, `tail.y=${tp.y}`)
  check('窗口下缘不出屏', p.y + SIZE.height <= WA.y + WA.height - EDGE_MARGIN)
}

// 3. 水平越界（右侧）→ clamp 内收，纵向仍正常
{
  console.log('用例 3：右侧越界 → 横向 clamp 内收')
  const anchor = { x: 1900, y: 500 } // 1900 - 48 + 216 远超右缘
  const p = computeBubblePlacement(anchor, SIZE, WA)
  check(
    '右缘不超工作区',
    p.x + SIZE.width <= WA.x + WA.width - EDGE_MARGIN,
    `x=${p.x} right=${p.x + SIZE.width}`
  )
  check('纵向仍为后上放置', p.tail === 'down' && p.y + SIZE.height === anchor.y + TAIL_INSET_Y - TAIL_GAP)
}

// 4. 水平越界（左侧）→ clamp 内收
{
  console.log('用例 4：左侧越界 → 横向 clamp 内收')
  const anchor = { x: 10, y: 500 }
  const p = computeBubblePlacement(anchor, SIZE, WA)
  check('左缘不超工作区', p.x >= WA.x + EDGE_MARGIN, `x=${p.x}`)
}

// 5. 两侧都放不下（锚点居中 + 矮工作区）→ 选空间大侧 + 夹进工作区（不崩）
{
  console.log('用例 5：上下都放不下 → 选空间大侧 + clamp')
  const wa: Rect = { x: 0, y: 0, width: 1920, height: 300 }
  const p = computeBubblePlacement({ x: 800, y: 200 }, SIZE, wa) // 上方 200、下方 100 → 选 down
  check('选空间较大的 down 侧', p.tail === 'down')
  check(
    '窗口被夹进工作区',
    p.y >= wa.y + EDGE_MARGIN && p.y + SIZE.height <= wa.y + wa.height - EDGE_MARGIN,
    `y=${p.y}`
  )
}

// 6. 工作区比窗还小（极端退化）→ 不崩、窗口夹在边缘（不产生 NaN/负值）
{
  console.log('用例 6：工作区比窗还小（退化）')
  const wa: Rect = { x: 0, y: 0, width: 100, height: 100 }
  const p = computeBubblePlacement({ x: 50, y: 50 }, SIZE, wa)
  check('坐标有效（无 NaN）', Number.isFinite(p.x) && Number.isFinite(p.y))
  check('夹在最边缘（近似原点 + 边距）', p.x === EDGE_MARGIN && p.y === EDGE_MARGIN, `(${p.x},${p.y})`)
}

// 7. 副屏偏移工作区（x/y 非零起点）→ 尾尖对准副屏坐标系的锚点
{
  console.log('用例 7：副屏工作区（非零起点）')
  const wa: Rect = { x: 1920, y: 0, width: 1920, height: 1080 }
  const anchor = { x: 2800, y: 500 }
  const p = computeBubblePlacement(anchor, SIZE, wa)
  const tp = tailPoint(p)
  check('尾尖 x 对准锚点（副屏坐标系）', tp.x === anchor.x, `tail.x=${tp.x}`)
  check('窗口在副屏工作区内', p.x >= wa.x + EDGE_MARGIN)
}

// ------------------------------------------------------------------ 汇总

console.log('')
console.log(`=== bubble geometry 离线测试：${pass} 通过 / ${failures.length} 失败 ===`)
if (failures.length > 0) {
  for (const f of failures) console.error(` - ${f}`)
  process.exitCode = 1
}
