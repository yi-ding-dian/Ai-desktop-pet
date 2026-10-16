/**
 * xdotool 光标源（Linux，轮询式实时查询）：周期执行 `xdotool getmouselocation --shell`
 * 读取真实指针位置（底层是 XQueryPointer —— 请求-应答式服务器查询）。
 *
 * ─── 为什么不是 XI2 事件流（2026-10-16 实测，重要教训）───
 * 曾实现在 `xinput test-xi2 --root` 之上（订阅 root 窗口的 XI2 指针事件流），但精确对照实验表明：
 *  - XI2 指针事件按"指针下窗口"投递，并在第一个选择了该事件的窗口处**停止向上传播**——
 *    现代应用（含 Electron 自身与用户的浏览器等）都选择 XI2 指针事件 → 指针位于它们上方时
 *    root 观察者收不到任何事件。实测：同一 warp 序列，无窗口环境 2/2 事件、有窗口环境 0 事件；
 *    指定设备（`xinput test-xi2 <id>`）同样被截获（0 事件）。
 *  - 桌面宠物场景中指针必然频繁位于窗口上 → XI2 路线不可用（已弃用并从代码中移除）。
 * XQueryPointer（本实现）与事件选择/窗口/grab 无关，任何时刻都返回服务器权威位置。
 *
 * ─── 实测成本与选型 ───
 *  - 单次查询 ~2ms wall / ~1.2ms CPU（100 次合计 0.21s）→ 50ms 轮询 ≈ 2-3% 单核，桌宠可接受；
 *  - 查询是只读请求，不改变任何输入状态 → **零丢击**（对比 screen+脉冲方案在脉冲窗口期的丢击）；
 *  - 可用性：xdotool 缺失 / 连续查询失败 → isFailed() 交降级组合器（screen + 脉冲方案兜底）。
 *  - 更低开销的未来优化（本轮不做）：常驻 python3 ctypes 进程（XQueryPointer 微秒级）——
 *    依赖系统 python3（打包分发不保证），故优先选零新语言依赖的 xdotool。
 */
import { execFile } from 'node:child_process'
import type { Point } from './index'
import type { HitGateCursorSource } from './cursor-source'

/** 轮询间隔（ms；缺省 50 与 hit-gate 轮询同频） */
const DEFAULT_INTERVAL_MS = 50
/** 连续失败上限（达到即判定不可用） */
const DEFAULT_MAX_FAILURES = 3
/** 单次查询超时（ms，防子进程悬挂） */
const QUERY_TIMEOUT_MS = 500

/** 解析 `xdotool getmouselocation --shell` 输出（导出供离线测试） */
export function parseXdotoolLocation(stdout: string): Point | null {
  const mx = /^X=(-?\d+)\s*$/m.exec(stdout)
  const my = /^Y=(-?\d+)\s*$/m.exec(stdout)
  if (!mx || !my) return null
  return { x: Number(mx[1]), y: Number(my[1]) }
}

const defaultQuery = (): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile('xdotool', ['getmouselocation', '--shell'], { timeout: QUERY_TIMEOUT_MS }, (err, stdout) => {
      if (err) reject(err)
      else resolve(stdout)
    })
  })

export interface XdotoolCursorSourceOptions {
  log?(msg: string): void
  /** 轮询间隔（ms；缺省 50，测试可注入更小值） */
  intervalMs?: number
  /** 连续失败上限（缺省 3） */
  maxFailures?: number
  /** 查询注入（离线测试 mock；缺省 execFile xdotool） */
  queryImpl?: () => Promise<string>
}

/** 创建 xdotool 光标源（Linux；失败经 isFailed() 信号交组合器降级） */
export function createXdotoolCursorSource(opts: XdotoolCursorSourceOptions = {}): HitGateCursorSource {
  const log = opts.log ?? ((msg: string) => console.log(`[window/xdotool-cursor] ${msg}`))
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS
  const maxFailures = opts.maxFailures ?? DEFAULT_MAX_FAILURES
  const query = opts.queryImpl ?? defaultQuery

  let started = false
  let failed = false
  let failures = 0
  /** 防重入（单次查询 ~2ms，正常不重叠；超时兜底 500ms） */
  let busy = false
  let timer: NodeJS.Timeout | null = null
  let point: Point | null = null

  const stopTimer = (): void => {
    if (timer !== null) {
      clearInterval(timer)
      timer = null
    }
  }

  const fail = (why: string): void => {
    if (failed) return
    failed = true
    log(`不可用（${why}）→ 停止并交降级组合器`)
    stopTimer()
  }

  const pollOnce = async (): Promise<void> => {
    if (busy) return
    busy = true
    try {
      const out = await query()
      if (!started) return // stop() 期间的结果丢弃
      const p = parseXdotoolLocation(out)
      if (p === null) {
        failures += 1
        if (failures === 1) log('查询输出无法解析（xdotool 版本差异？）')
      } else {
        failures = 0
        point = p
      }
    } catch (err) {
      if (!started) return
      failures += 1
      if (failures === 1) log(`查询失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      busy = false
    }
    if (started && failures >= maxFailures) fail(`连续 ${failures} 次查询失败`)
  }

  return {
    read: () => point,
    /** 实时源：轮询机制本身即是"服务器实时查询"（只要已启动且未判失败——首查前的短暂 null 不算降级） */
    isLive: () => started && !failed,
    isFailed: () => failed,
    start: () => {
      if (started) return
      started = true
      failed = false
      failures = 0
      point = null
      void pollOnce() // 立即首查（首个坐标尽快可用）
      timer = setInterval(() => void pollOnce(), intervalMs)
    },
    stop: () => {
      started = false
      stopTimer()
      point = null
    }
  }
}
