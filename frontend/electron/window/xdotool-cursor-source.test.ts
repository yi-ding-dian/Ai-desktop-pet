/**
 * xdotool 光标源与降级组合器 —— 离线自测（mock 查询；不依赖 Electron 与真实 xdotool）。
 *
 * 运行方式（esbuild 打包后以 Node 执行）：
 *   cd frontend
 *   node_modules/.bin/esbuild electron/window/xdotool-cursor-source.test.ts --bundle --platform=node --format=esm \
 *     --outfile=out/tests/xdotool-cursor-source.test.mjs && node out/tests/xdotool-cursor-source.test.mjs
 *
 * 覆盖：--shell 输出解析（正常/缺字段/负数）；轮询（首查即用、值更新、stop 后停止）；
 *       失败路径（查询抛错/坏输出 → 连续失败上限 → isFailed 降级）；
 *       降级组合器（primary 失败 → 永久切 fallback + 日志一次）。
 */
import { createXdotoolCursorSource, parseXdotoolLocation } from './xdotool-cursor-source'
import { createDegradableCursorSource, type ClickThroughCursorSource } from './cursor-source'

// ---------------------------------------------------------------- 断言工具

let pass = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    pass += 1
    console.log(`  ✓ ${name}`)
  } else {
    failures.push(name + (detail ? `（${detail}）` : ''))
    console.error(`  ✗ ${name} ${detail}`)
  }
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

const SHELL_OUT = (x: number, y: number): string => `X=${x}\nY=${y}\nSCREEN=0\nWINDOW=243269636\n`

// ---------------------------------------------------------------- 用例

// 1. 解析器
{
  console.log('用例 1：--shell 输出解析')
  const p = parseXdotoolLocation(SHELL_OUT(600, 350))
  check('正常输出 → {600,350}', p !== null && p.x === 600 && p.y === 350, JSON.stringify(p))
  const neg = parseXdotoolLocation(SHELL_OUT(-120, -45))
  check('负坐标（多屏拼接）→ {-120,-45}', neg !== null && neg.x === -120 && neg.y === -45, JSON.stringify(neg))
  check('缺 Y 字段 → null', parseXdotoolLocation('X=100\nSCREEN=0\n') === null)
  check('坏输出 → null', parseXdotoolLocation('garbage') === null)
  check('空输出 → null', parseXdotoolLocation('') === null)
}

// 2. 轮询：首查即用 / 值更新 / stop 清理
{
  console.log('用例 2：轮询行为')
  let cursor = { x: 600, y: 350 }
  let queries = 0
  const src = createXdotoolCursorSource({
    intervalMs: 10,
    log: () => {},
    queryImpl: async () => {
      queries += 1
      return SHELL_OUT(cursor.x, cursor.y)
    }
  })
  check('未启动 read() 为 null', src.read() === null)
  check('未启动 isLive() 为 false', src.isLive() === false)
  src.start()
  check('start 后 isLive() 为 true（实时源）', src.isLive() === true)
  await sleep(5) // 首查是立即触发的异步
  check('首查即用（无需等轮询间隔）', src.read() !== null && src.read()!.x === 600)
  cursor = { x: 450, y: 250 }
  await sleep(30)
  check('轮询跟随更新', src.read()!.x === 450 && src.read()!.y === 250, JSON.stringify(src.read()))
  src.stop()
  const n = queries
  await sleep(30)
  check('stop 后不再查询', queries === n)
  check('stop 后 read() 归 null', src.read() === null)
  check('stop 后 isLive() 为 false', src.isLive() === false)
}

// 3. 失败路径：连续查询失败 → 判定不可用（降级信号）
{
  console.log('用例 3：连续失败 → 降级信号')
  const src = createXdotoolCursorSource({
    intervalMs: 10,
    maxFailures: 3,
    log: () => {},
    queryImpl: async () => {
      throw new Error('xdotool not found')
    }
  })
  src.start()
  await sleep(80)
  check('连续失败达上限 → isFailed()', src.isFailed?.() === true)
  check('降级后 isLive() 为 false（click-through 将启用脉冲）', src.isLive() === false)
  src.stop()

  // 坏输出同样计入失败（xdotool 版本差异等）
  const src2 = createXdotoolCursorSource({
    intervalMs: 10,
    maxFailures: 2,
    log: () => {},
    queryImpl: async () => 'unexpected format'
  })
  src2.start()
  await sleep(60)
  check('无法解析的输出计入失败 → isFailed()', src2.isFailed?.() === true)
  src2.stop()
}

// 4. 单次失败后恢复：不误判（阈值内）
{
  console.log('用例 4：偶发失败不误判')
  let n = 0
  const src = createXdotoolCursorSource({
    intervalMs: 10,
    maxFailures: 3,
    log: () => {},
    queryImpl: async () => {
      n += 1
      if (n === 2) throw new Error('transient')
      return SHELL_OUT(100 + n, 200)
    }
  })
  src.start()
  await sleep(60)
  check('偶发失败后恢复（未达阈值 → 不降级）', src.isFailed?.() === false && src.read() !== null)
  src.stop()
}

// 5. 降级组合器：primary 失败 → 永久切 fallback
{
  console.log('用例 5：降级组合器')
  const primaryPoint = { x: 11, y: 22 }
  let primaryFailed = false
  const primary: ClickThroughCursorSource = {
    read: () => primaryPoint,
    isLive: () => true,
    isFailed: () => primaryFailed,
    start: () => {},
    stop: () => {}
  }
  const fallbackPoint = { x: 33, y: 44 }
  const fallback = {
    read: () => fallbackPoint,
    isLive: () => false,
    start: () => {},
    stop: () => {}
  }
  const logs: string[] = []
  const combo = createDegradableCursorSource(primary, fallback, (m) => logs.push(m))
  check('primary 正常 → read 用 primary', combo.read() === primaryPoint)
  check('primary 正常 → isLive 用 primary', combo.isLive() === true)
  primaryFailed = true
  check('primary 失败 → read 切 fallback', combo.read() === fallbackPoint)
  check('primary 失败 → isLive 变 false（click-through 将启用脉冲）', combo.isLive() === false)
  check('降级日志提示一次', logs.length === 1, JSON.stringify(logs))
  check('重复读取不重复提示', logs.length === 1)
}

// ---------------------------------------------------------------- 汇总

console.log('')
console.log(`=== xdotool 光标源离线测试：${pass} 通过 / ${failures.length} 失败 ===`)
if (failures.length > 0) {
  for (const f of failures) console.error(` - ${f}`)
}
// 显式退出：避免任何残留定时器让进程挂住（测试内各源均已 stop，此为兜底）
process.exit(failures.length > 0 ? 1 : 0)
