/**
 * click-through 输入接管状态机 —— 离线自测（mock 窗口/时钟，不依赖 Electron 运行时）。
 *
 * 运行方式（esbuild 打包后以 Node 执行）：
 *   cd frontend
 *   node_modules/.bin/esbuild electron/window/click-through.test.ts --bundle --platform=node --format=esm \
 *     --outfile=/tmp/click-through.test.mjs && node /tmp/click-through.test.mjs
 *
 * 覆盖：TAKEN→空气→YIELDED；YIELDED→回实体→TAKEN；防抖（连续一致/最短间隔/交替不累计）；
 *       出窗保持 + null 边沿；隐藏/最小化守卫与恢复；拖拽恒实体路径；脉冲机制；销毁守卫；坐标边界。
 */
import { createClickThrough, CLICK_THROUGH_TIMING, type ClickThroughScheduler, type ClickThroughWindow } from './click-through'
import type { ClickThroughCursorSource } from './cursor-source'

// ---------------------------------------------------------------- 假时钟调度器

class FakeScheduler implements ClickThroughScheduler {
  private t = 0
  private seq = 0
  private timers = new Map<number, { fn: () => void; at: number; every: number | null }>()

  now(): number {
    return this.t
  }

  setInterval(fn: () => void, ms: number): unknown {
    const id = ++this.seq
    this.timers.set(id, { fn, at: this.t + ms, every: ms })
    return id
  }

  clearInterval(h: unknown): void {
    this.timers.delete(h as number)
  }

  setTimeout(fn: () => void, ms: number): unknown {
    const id = ++this.seq
    this.timers.set(id, { fn, at: this.t + ms, every: null })
    return id
  }

  clearTimeout(h: unknown): void {
    this.timers.delete(h as number)
  }

  /** 推进时间并按到期顺序执行定时器（interval 自动重排） */
  advance(ms: number): void {
    const end = this.t + ms
    for (;;) {
      let nextId: number | null = null
      let nextAt = Infinity
      for (const [id, tm] of this.timers) {
        if (tm.at <= end && tm.at < nextAt) {
          nextAt = tm.at
          nextId = id
        }
      }
      if (nextId === null) break
      const tm = this.timers.get(nextId)!
      this.t = tm.at
      if (tm.every === null) this.timers.delete(nextId)
      else tm.at = this.t + tm.every
      tm.fn()
    }
    this.t = end
  }

  get pending(): number {
    return this.timers.size
  }
}

// ---------------------------------------------------------------- 假窗口

interface FakeWindow extends ClickThroughWindow {
  ignoreState: boolean
  ignoreCalls: boolean[]
  sent: Array<{ channel: string; payload: unknown }>
  visible: boolean
  minimized: boolean
  destroyed: boolean
  bounds: { x: number; y: number; width: number; height: number }
  emit(event: 'show' | 'hide' | 'minimize' | 'restore'): void
}

function createFakeWindow(): FakeWindow {
  const handlers = new Map<string, Set<() => void>>()
  const w: FakeWindow = {
    ignoreState: false,
    ignoreCalls: [],
    sent: [],
    visible: true,
    minimized: false,
    destroyed: false,
    bounds: { x: 100, y: 100, width: 400, height: 400 },
    setIgnoreMouseEvents(ignore: boolean): void {
      w.ignoreState = ignore
      w.ignoreCalls.push(ignore)
    },
    isVisible: () => w.visible,
    isDestroyed: () => w.destroyed,
    isMinimized: () => w.minimized,
    getBounds: () => w.bounds,
    on(event, listener) {
      if (!handlers.has(event)) handlers.set(event, new Set())
      handlers.get(event)!.add(listener)
      return w
    },
    removeListener(event, listener) {
      handlers.get(event)?.delete(listener)
      return w
    },
    webContents: {
      send(channel: string, payload?: unknown): void {
        w.sent.push({ channel, payload })
      }
    },
    emit(event) {
      for (const fn of [...(handlers.get(event) ?? [])]) fn()
    }
  }
  return w
}

// ---------------------------------------------------------------- 假坐标源

interface FakeCursorSource extends ClickThroughCursorSource {
  point: { x: number; y: number } | null
  live: boolean
  startCount: number
  stopCount: number
}

function createFakeCursorSource(point: { x: number; y: number } = { x: 300, y: 300 }): FakeCursorSource {
  const s: FakeCursorSource = {
    point: { ...point },
    live: false,
    startCount: 0,
    stopCount: 0,
    read: () => s.point,
    isLive: () => s.live,
    start: () => {
      s.startCount += 1
    },
    stop: () => {
      s.stopCount += 1
    }
  }
  return s
}

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

const T = CLICK_THROUGH_TIMING

function setup(cursor: { x: number; y: number } = { x: 300, y: 300 }) {
  const sched = new FakeScheduler()
  const win = createFakeWindow()
  const source = createFakeCursorSource(cursor)
  const gate = createClickThrough({ win, cursorSource: source, scheduler: sched })
  return { sched, win, gate, source }
}

/** 快进一个轮询周期（触发一次 tick） */
const TICK = T.POLL_INTERVAL_MS + 1

// ---------------------------------------------------------------- 用例

// 1. 初值 YIELDED + 启停
{
  console.log('用例 1：初值 YIELDED 与启停')
  const { sched, win, gate } = setup()
  gate.start()
  check('start 后初值 YIELDED（窗口输入让路 ignore=true）', gate.getState() === 'yielded' && win.ignoreState === true)
  check('start 后轮询定时器已建', sched.pending > 0)
  gate.stop()
  check('stop 后定时器全部清理', sched.pending === 0)
}

// 2. TAKEN→空气→YIELDED（报告 + 确认窗口，渲染侧"变化才上报"语义）
{
  console.log('用例 2：TAKEN → 空气 → YIELDED（报告 + 确认窗口）')
  const { sched, win, gate } = setup()
  gate.start()
  gate.notifyReport(true)
  check('单次报告未过确认窗口 → 不切', gate.getState() === 'yielded')
  sched.advance(T.DEBOUNCE_CONFIRM_MS + 5)
  check('单次报告 + 确认窗口到期 → TAKEN（接管）', gate.getState() === 'taken' && win.ignoreState === false)

  gate.notifyReport(false)
  check('空气报告瞬间不切（确认窗口内）', gate.getState() === 'taken')
  // 推进到确认到期（+1ms 避开下一个轮询 tick 的脉冲时刻：让路态脉冲会短暂关让路）
  sched.advance(T.DEBOUNCE_CONFIRM_MS + 1)
  check('空气报告 + 确认窗口 → YIELDED（让路）', gate.getState() === 'yielded' && win.ignoreState === true)
}

// 3. YIELDED→回实体→TAKEN（滑入恢复）
{
  console.log('用例 3：YIELDED → 回实体 → TAKEN')
  const { sched, win, gate } = setup()
  gate.start()
  gate.notifyReport(true)
  sched.advance(T.DEBOUNCE_CONFIRM_MS + 5)
  check('让路态：报告实体 + 确认窗口 → TAKEN', gate.getState() === 'taken' && win.ignoreState === false)
}

// 4. 防抖：候选被推翻 / 重新报告 / 密集报告提前触发
{
  console.log('用例 4：防抖一致性（候选推翻与密集报告路径）')
  const { sched, gate } = setup()
  gate.start()
  gate.notifyReport(true) // 候选 true + 确认窗口
  gate.notifyReport(false) // 与当前状态（yielded）一致 → 推翻候选、取消确认
  sched.advance(T.DEBOUNCE_CONFIRM_MS + 5)
  check('确认窗口内候选被推翻 → 不切', gate.getState() === 'yielded')
  gate.notifyReport(true)
  sched.advance(T.DEBOUNCE_CONFIRM_MS + 5)
  check('重新报告 + 确认窗口 → 正常切换', gate.getState() === 'taken')

  // 密集报告路径：连续 2 次一致 → 立即切换（无需等待确认窗口）
  const d = setup()
  d.gate.start()
  d.gate.notifyReport(true)
  d.gate.notifyReport(true)
  check('连续 2 次一致 → 立即 TAKEN（密集报告路径）', d.gate.getState() === 'taken')
}

// 5. 出窗保持 + null 边沿 + 窗内坐标推送
{
  console.log('用例 5：光标窗内推送 / 出窗边沿 / 出窗保持')
  const { sched, win, gate, source } = setup({ x: 300, y: 300 }) // 窗口内 (200,200)
  gate.start()
  sched.advance(TICK)
  const pushed = win.sent.filter((s) => s.payload !== null)
  check(
    '窗内推送窗口内坐标 {200,200}',
    pushed.some((s) => (s.payload as { x: number }).x === 200 && (s.payload as { y: number }).y === 200),
    JSON.stringify(pushed.map((s) => s.payload))
  )
  check('窗内无渲染报告 → 保持 YIELDED', gate.getState() === 'yielded')

  source.point = { x: 0, y: 0 } // 窗口外
  const nullBefore = win.sent.filter((s) => s.payload === null).length
  sched.advance(TICK)
  const nullAfter = win.sent.filter((s) => s.payload === null).length
  check('出窗边沿推送一次 null', nullAfter === nullBefore + 1, `before=${nullBefore} after=${nullAfter}`)
  sched.advance(T.POLL_INTERVAL_MS * 3)
  check('出窗保持：不反复推 null', win.sent.filter((s) => s.payload === null).length === nullAfter)
  check('出窗保持 YIELDED（不切换）', gate.getState() === 'yielded')
}

// 6. 隐藏/最小化守卫与恢复
{
  console.log('用例 6：隐藏守卫（停轮询 + 状态复位）与恢复')
  const { sched, win, gate } = setup()
  gate.start()
  gate.notifyReport(true)
  gate.notifyReport(true)
  check('前置：已进入 TAKEN', gate.getState() === 'taken')

  win.visible = false
  win.emit('hide')
  check('隐藏 → 停轮询（无定时器）', sched.pending === 0)
  check('隐藏 → 状态复位 YIELDED 且输入让路', gate.getState() === 'yielded' && win.ignoreState === true)
  const sentBefore = win.sent.length
  sched.advance(1000)
  check('隐藏期间无任何推送', win.sent.length === sentBefore)

  win.visible = true
  win.emit('show')
  check('显示 → 轮询恢复', sched.pending > 0)
  sched.advance(TICK)
  check('恢复后推送恢复', win.sent.length > sentBefore)
}

// 7. 最小化守卫
{
  console.log('用例 7：最小化守卫')
  const { sched, win, gate } = setup()
  gate.start()
  win.minimized = true
  win.emit('minimize')
  check('最小化 → 停轮询', sched.pending === 0)
  win.minimized = false
  win.emit('restore')
  check('还原 → 轮询恢复', sched.pending > 0)
}

// 8. 拖拽恒实体路径：持续 solid=true 自然保持 TAKEN
{
  console.log('用例 8：拖拽恒实体（渲染持续 solid=true）')
  const { sched, win, gate } = setup()
  gate.start()
  gate.notifyReport(true)
  gate.notifyReport(true)
  for (let i = 0; i < 10; i++) {
    gate.notifyReport(true)
    sched.advance(30)
  }
  check('持续报实体 → 保持 TAKEN（不切让路）', gate.getState() === 'taken' && win.ignoreState === false)
}

// 9. 脉冲机制
{
  console.log('用例 9：脉冲（X11 缓存刷新）')
  const a = setup()
  a.gate.start()
  a.sched.advance(TICK) // 首个 tick 立即脉冲
  check('脉冲开始 → 短暂关让路（ignore=false）', a.win.ignoreState === false && a.gate.getState() === 'yielded')
  a.sched.advance(T.PULSE_MS + 1)
  check('脉冲结束 → 回切让路（ignore=true）', a.win.ignoreState === true && a.gate.getState() === 'yielded')

  const b = setup()
  b.gate.start()
  b.sched.advance(TICK) // 脉冲进行中
  b.gate.notifyReport(true)
  b.gate.notifyReport(true)
  check('脉冲期间报实体 → TAKEN', b.gate.getState() === 'taken' && b.win.ignoreState === false)
  b.sched.advance(T.PULSE_MS + 5)
  check('TAKEN 后脉冲回切被取消（保持接管）', b.gate.getState() === 'taken' && b.win.ignoreState === false)
}

// 10. 销毁守卫
{
  console.log('用例 10：销毁守卫')
  const { sched, win, gate } = setup()
  gate.start()
  win.destroyed = true
  sched.advance(TICK)
  check('销毁 → 状态机停止（定时器清理）', sched.pending === 0)
  let safe = true
  try {
    gate.notifyReport(true)
  } catch {
    safe = false
  }
  check('销毁后 notifyReport 安全（不抛错）', safe)
}

// 11. 坐标边界
{
  console.log('用例 11：窗口内坐标边界')
  const { sched, win, gate, source } = setup({ x: 100 + 399, y: 100 + 399 })
  gate.start()
  sched.advance(TICK)
  check(
    '右下角 (399,399) 视为窗内',
    win.sent.some((s) => s.payload !== null && (s.payload as { x: number }).x === 399 && (s.payload as { y: number }).y === 399)
  )
  source.point = { x: 100 + 400, y: 300 } // 恰在窗口外
  const n = win.sent.filter((s) => s.payload === null).length
  sched.advance(TICK)
  check('x=400（恰在窗外）判出窗', win.sent.filter((s) => s.payload === null).length === n + 1)
}

// 12. 状态只由渲染报告驱动：TAKEN 下指针出窗不自主切换（无害保持；回归由报告链路负责）
{
  console.log('用例 12：TAKEN 下出窗不自主切换（状态只由报告驱动）')
  const { sched, win, gate, source } = setup()
  gate.start()
  gate.notifyReport(true)
  gate.notifyReport(true)
  check('前置：已进入 TAKEN', gate.getState() === 'taken')

  source.point = { x: 1700, y: 900 } // 指针瞬移出窗（无 pointermove 事件流）
  sched.advance(TICK * 4)
  check('出窗保持 TAKEN（窗口不吃窗外点击，无害）', gate.getState() === 'taken')

  // 报告链恢复：渲染判定变化（空气）→ 正常让路
  gate.notifyReport(false)
  sched.advance(T.DEBOUNCE_CONFIRM_MS + 1)
  check('渲染报空气 → 正常让路 YIELDED', gate.getState() === 'yielded' && win.ignoreState === true)
}

// 13. 实时源（XI2）：不发脉冲（丢击窗口消失），坐标照常推送
{
  console.log('用例 13：实时坐标源（XI2）——无脉冲')
  const { sched, win, gate, source } = setup()
  source.live = true
  gate.start()
  const callsBefore = win.ignoreCalls.length
  sched.advance(TICK * 6) // 跨越多个脉冲周期（若启用脉冲必然出现 false）
  const newCalls = win.ignoreCalls.slice(callsBefore)
  check('实时源下全程无脉冲（无 ignore=false 抖动）', !newCalls.includes(false) && win.ignoreState === true)
  check('实时源下坐标照常推送', win.sent.some((s) => s.payload !== null))
}

// 14. 坐标源生命周期（随 click-through 启动/暂停/恢复/停止转发）
{
  console.log('用例 14：坐标源生命周期')
  const { win, gate, source } = setup()
  gate.start()
  check('start → 坐标源已启动', source.startCount === 1)
  win.visible = false
  win.emit('hide')
  check('隐藏 → 坐标源已停止（XI2 子进程省开销）', source.stopCount === 1)
  win.visible = true
  win.emit('show')
  check('恢复 → 坐标源再次启动', source.startCount === 2)
  gate.stop()
  check('停止 → 坐标源已停止', source.stopCount === 2)
}

// 15. 坐标源无数据（read null）：跳过推送（TAKEN 下无轮询）
{
  console.log('用例 15：坐标源无数据（xdotool 首查前）')
  const { sched, win, gate, source } = setup()
  source.point = null
  gate.start()
  const sent0 = win.sent.length
  sched.advance(TICK * 2)
  check('read null → 不推送坐标', win.sent.length === sent0)
  gate.notifyReport(true)
  gate.notifyReport(true)
  check('前置：已进入 TAKEN', gate.getState() === 'taken')
  sched.advance(TICK * 5)
  check('TAKEN 无轮询：read null 无影响', gate.getState() === 'taken')
}

// 16. 切到 YIELDED 补推 null（给渲染侧的"状态已让路"去重重置信号）
{
  console.log('用例 16：让路切换补推 null 信号')
  const { sched, win, gate } = setup()
  gate.start()
  gate.notifyReport(true)
  gate.notifyReport(true)
  const n0 = win.sent.filter((s) => s.payload === null).length
  gate.notifyReport(false)
  sched.advance(T.DEBOUNCE_CONFIRM_MS + 1)
  const n1 = win.sent.filter((s) => s.payload === null).length
  check('切换到 YIELDED → 补推一次 null', gate.getState() === 'yielded' && n1 === n0 + 1, `n0=${n0} n1=${n1}`)
}

// ---------------------------------------------------------------- 汇总

console.log('')
console.log(`=== click-through 离线测试：${pass} 通过 / ${failures.length} 失败 ===`)
if (failures.length > 0) {
  for (const f of failures) console.error(` - ${f}`)
  process.exitCode = 1
}
