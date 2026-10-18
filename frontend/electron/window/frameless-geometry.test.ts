/**
 * 无边框窗口几何（frameless-geometry）——离线自测（纯函数，不依赖 Electron 运行时）。
 *
 * 运行方式：cd frontend && npm run test:frameless-geometry
 *
 * 覆盖：
 *  - 四边/四角缩放只动被拖的边、对边固定；
 *  - 最小尺寸与工作区边距夹取；
 *  - 重复同目标尺寸幂等（回归 fractional DPI "按住边缘窗口自己往下跑"）；
 *  - 标题栏移位（累计位移、整窗夹回工作区、位移为 0 幂等）；
 *  - 记忆值恢复时的整窗夹取。
 */
import {
  clampFramelessRect,
  moveFramelessRect,
  resizeFramelessRect,
  type FramelessSizeLimits
} from './frameless-geometry'
import type { Rect } from './index'
import {
  applyRequestedBounds,
  clearRequestedBounds,
  noteRequestedBounds,
  readRequestedBounds
} from './request-bounds'

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

/** 标准工作区（副屏坐标） */
const WA: Rect = { x: 1920, y: 0, width: 1920, height: 1080 }
/** 通用窗口约束：最小 300×200、边距 10 */
const LIMITS: FramelessSizeLimits = { minWidth: 300, minHeight: 200, edgeMargin: 10 }
/** 窗口当前请求矩形 */
const CUR: Rect = { x: 2600, y: 100, width: 800, height: 700 }

function resize(
  cur: Rect,
  edges: { left?: boolean; right?: boolean; top?: boolean; bottom?: boolean },
  width = cur.width,
  height = cur.height
): Rect | null {
  return resizeFramelessRect(
    cur,
    {
      width,
      height,
      left: edges.left ?? false,
      right: edges.right ?? false,
      top: edges.top ?? false,
      bottom: edges.bottom ?? false
    },
    WA,
    LIMITS
  )
}

// ---------------------------------------------------------------- 四边/四角

const left = resize(CUR, { left: true }, 900)
check('拖左缘：宽度 = 目标值', left?.width === 900, `got=${left?.width}`)
check('拖左缘：右缘固定', left !== null && left.x + left.width === CUR.x + CUR.width)
check('拖左缘：高度/纵向位置不变', left?.y === CUR.y && left?.height === CUR.height)

const right = resize(CUR, { right: true }, 700)
check('拖右缘：左缘固定', right?.x === CUR.x)
check('拖右缘：宽度 = 目标值', right?.width === 700)

const top = resize(CUR, { top: true }, CUR.width, 600)
check('拖上缘：下缘固定', top !== null && top.y + top.height === CUR.y + CUR.height)
check('拖上缘：高度 = 目标值', top?.height === 600)

const bottom = resize(CUR, { bottom: true }, CUR.width, 500)
check('拖下缘：上缘固定', bottom?.y === CUR.y)
check('拖下缘：高度 = 目标值', bottom?.height === 500)

const nw = resize(CUR, { left: true, top: true }, 900, 600)
check(
  '拖左上角：右缘与下缘同时固定',
  nw !== null &&
    nw.x + nw.width === CUR.x + CUR.width &&
    nw.y + nw.height === CUR.y + CUR.height
)

// ---------------------------------------------------------------- 夹取 / 幂等 / 回归

check('尺寸未变返回 null（不 setBounds）', resize(CUR, {}) === null)
check('宽度下限 = minWidth', resize(CUR, { left: true }, 10)?.width === LIMITS.minWidth)
check('高度下限 = minHeight', resize(CUR, { bottom: true }, CUR.width, 10)?.height === LIMITS.minHeight)

const leftClamped = resize(CUR, { left: true }, 99999)
check('左缘不越出工作区（留边距）', leftClamped?.x === WA.x + 10, `got=${leftClamped?.x}`)

// 回归：重复上报同一目标尺寸必须幂等，高度不得逐次增长
check('重复同目标尺寸 = 幂等（窗口不自己漂移）', left !== null && resize(left, { left: true }, 900) === null)

// ---------------------------------------------------------------- 移位

const moved = moveFramelessRect(CUR, -40, -20, WA, LIMITS)
check('移位：x/y 按累计位移平移', moved?.x === CUR.x - 40 && moved?.y === CUR.y - 20)
check('移位：尺寸不变', moved?.width === CUR.width && moved?.height === CUR.height)
check('位移为 0 返回 null（幂等）', moveFramelessRect(CUR, 0, 0, WA, LIMITS) === null)

const movedFar = moveFramelessRect(CUR, 99999, 99999, WA, LIMITS)
check(
  '移位：整窗夹进工作区（右/下留边距）',
  movedFar !== null &&
    movedFar.x + movedFar.width === WA.x + WA.width - 10 &&
    movedFar.y + movedFar.height === WA.y + WA.height - 10,
  `got=${movedFar?.x},${movedFar?.y}`
)

// ---------------------------------------------------------------- 恢复记忆

const restored = clampFramelessRect({ x: -500, y: -500, width: 50, height: 20 }, WA, LIMITS)
check(
  '恢复记忆：尺寸与位置夹回工作区（最小尺寸 + 边距）',
  restored.x === WA.x + 10 &&
    restored.y === WA.y + 10 &&
    restored.width === LIMITS.minWidth &&
    restored.height === LIMITS.minHeight,
  `got=${restored.x},${restored.y},${restored.width},${restored.height}`
)

// ---------------------------------------------------------------- 请求值 bounds 缓存（fractional DPI 契约）

type FakeWindow = Parameters<typeof noteRequestedBounds>[0]

/** 最小假窗口：记录 setBounds 次数，可模拟"getBounds 回吐舍入值" */
class FakeWin {
  bounds: Rect = { x: 10, y: 20, width: 800, height: 600 }
  setCalls = 0
  getCalls = 0
  destroyed = false

  getBounds(): Rect {
    this.getCalls += 1
    return { ...this.bounds }
  }

  setBounds(rect: Rect): void {
    this.setCalls += 1
    this.bounds = { ...rect }
  }

  isDestroyed(): boolean {
    return this.destroyed
  }
}

const fake = new FakeWin()
const win = fake as unknown as FakeWindow

const firstRead = readRequestedBounds(win)
check('首次读取回退 getBounds 并记账', firstRead.width === 800 && fake.getCalls === 1)

// 模拟系统层回吐舍入值：缓存存在时不得再读 getBounds
fake.bounds = { x: 11, y: 21, width: 801, height: 601 }
const secondRead = readRequestedBounds(win)
check(
  '缓存命中后不再读 getBounds（切断舍入值回喂）',
  secondRead.width === 800 && fake.getCalls === 1,
  `getCalls=${fake.getCalls}`
)

applyRequestedBounds(win, { x: 30, y: 40, width: 900, height: 700 })
check('applyRequestedBounds 会写窗口并记账', fake.setCalls === 1 && readRequestedBounds(win).width === 900)

fake.setCalls = 0
noteRequestedBounds(win, { x: 50, y: 60, width: 1000, height: 800 })
check(
  'noteRequestedBounds 只记账、不 setBounds',
  fake.setCalls === 0 && readRequestedBounds(win).width === 1000
)

clearRequestedBounds(win)
fake.bounds = { x: 70, y: 80, width: 1100, height: 900 }
check('clear 后重新回退 getBounds', readRequestedBounds(win).width === 1100)

console.log(`\n=== frameless geometry 离线测试：${pass} 通过 / ${failures.length} 失败 ===`)
if (failures.length > 0) {
  failures.forEach((f) => console.error(`  ✗ ${f}`))
  process.exit(1)
}
