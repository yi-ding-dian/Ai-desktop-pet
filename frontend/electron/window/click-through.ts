/**
 * 空气让路 · 像素级命中：输入接管状态机（设计文档 §5.1「空气让路 · 像素级命中」增补块）。
 *
 * 职责：在「接管（TAKEN）/ 让路（YIELDED）」两态间切换宠物窗口的输入接收：
 *   TAKEN  —— 窗口正常接收输入；渲染侧 mousemove 实时 hitTest 驱动（报"空气"则让路，报"实体"维持）；
 *   YIELDED —— 输入全放行（setIgnoreMouseEvents(true, {forward:false})，X11 实测"只切输入不切显示"），
 *              本模块以 ~50ms 轮询读取坐标源并把窗口内坐标经 IPC_EVENTS.PET_POINTER_POS 推给渲染
 *              判定，收到"实体"回报（防抖后）恢复接管。
 *
 * 坐标源（cursor-source.ts 抽象，两种实现）：
 *   - xdotool 实时查询（Linux 首选：XQueryPointer 请求-应答式读取，零丢击）——见 xdotool-cursor-source.ts；
 *   - screen.getCursorScreenPoint()（降级/其他平台）——X11 实为事件驱动缓存，须配合**脉冲刷新**
 *     （见下方实测备忘③）；首选源不可用时组合器自动降级到此路径（丢击窗口回归但可用）。
 *
 * 与旧机制的关系（设计文档既定约定）：
 * - 本模块在宠物窗口启用后**全权接管输入切换**——渲染侧（支持 hitTest 的渲染器）停用旧悬停切换；
 * - F9 调试键（走 setShape 旧路径）保留不动，仅作调试绕过（见 main.ts 注释）；
 * - 拖拽中被渲染锁定为实体（渲染恒报 solid=true）→ 自然不切离开 TAKEN，无需专门分支。
 *
 * ─── X11 实测备忘（2026-10-16，Deepin/DDE + Electron 33；实验脚手架 /tmp/pet-hit-exp/out/）───
 * ① setIgnoreMouseEvents(true, {forward:false}) **只切输入不切显示**：透明窗红块切换前后截屏像素
 *    完全一致，且 xdotool 点击穿透到下层窗口（输入侧生效）；
 * ② screen.getCursorScreenPoint() 在 X11 下是**事件驱动缓存**：仅当本进程窗口收到指针事件时更新。
 *    穿透态下指针位于外部窗口（桌面/用户窗口）时**冻结**——实测：指针 warp 进窗口区域 / 连续 20 步
 *    滑入窗口，缓存全程零更新（历史"拖拽冻结"坑的根因确认，静止窗口同样适用）；
 * ③ 补救=**脉冲**：短暂 setIgnoreMouseEvents(false) 让窗口在指针位于其上时收到真实事件、缓存即刻刷新。
 *    实测：脉冲 ≥10ms 可靠、20ms 连续 20/20 稳定；脉冲不会改变"指针在窗外"的陈旧值（无事件源，预期）。
 *    代价：脉冲期间（PULSE_MS / PULSE_PERIOD_MS 占空比）指针位于空气区时的点击会被窗口吃掉——
 *    即"丢击概率"，常量集中可调（调小 PULSE_MS / 调大 PULSE_PERIOD_MS 降低丢击，代价是接管恢复更迟）。
 *
 * ─── 与渲染侧上报语义的对接（2026-10-16 真机集成冒烟实测倒逼的两处防抖语义修正）───
 * ① 渲染侧为"判定**变化**才上报"（去重，渲染侧契约如此）：同一判定不重复发——因此本状态机防抖
 *    不能只依赖"连续 N 次报告"，而是"报告 + **确认窗口**"：收到相反判定后，若 DEBOUNCE_CONFIRM_MS
 *    内没有相反报告（即判定保持）→ 视为稳定证据，执行切换；窗口内有相反报告 → 候选被推翻、不切。
 *    密集报告（每次事件都上报的未来实现）同样兼容：连续 N 次一致可提前触发（仍受最短间隔约束）。
 * ② 状态**只由渲染报告驱动**（+ 窗口隐藏等守卫复位）——主进程不做任何基于坐标的自主切换。
 *    实测教训：曾为"指针瞬移出窗口无报告"加过几何守卫（主进程读坐标自主让路），但这会与渲染侧
 *    的"变化才上报"去重值失去同步（守卫让路后渲染侧 lastSolid 仍为 true → 指针回到实体上时渲染
 *    判定无变化、不报告 → 主进程再也收不回接管权）。而"指针在窗外"本身无害：窗口不吃窗外点击，
 *    指针移动回窗内必经 pointermove → 渲染判定报告链路自然工作——故守卫状态切换整个移除。
 *    同理，切到 YIELDED 时主动补推一次 null（并重置出窗边沿），作为给渲染侧的"状态已让路"信号
 *    （渲染侧若把 null 视为"重置判定去重"则能进一步消除边界残留——见 pixel-hit-test 对接建议）。
 *
 * 平台无关：本模块不 import electron 运行时（仅类型 + 通道常量），依赖经 deps 注入（离线可测）。
 */
import { IPC_EVENTS } from '../ipc/channels'
import { isWindows } from '../platform'
import type { Point, Rect } from './index'
import type { ClickThroughCursorSource } from './cursor-source'

/** 状态机所需的最小窗口接口（BrowserWindow 结构兼容；离线测试注入假窗口） */
export interface ClickThroughWindow {
  /** 输入放行开关（ignore=true 时窗口不接收输入；forward 在 X11 下实测无效，显式 false） */
  setIgnoreMouseEvents(ignore: boolean, options?: { forward?: boolean }): void
  isVisible(): boolean
  isDestroyed(): boolean
  isMinimized(): boolean
  getBounds(): Rect
  on(event: 'show' | 'hide' | 'minimize' | 'restore', listener: () => void): unknown
  removeListener(event: 'show' | 'hide' | 'minimize' | 'restore', listener: () => void): unknown
  webContents: { send(channel: string, ...args: unknown[]): void }
}

/** 调度器抽象（默认=全局定时器；离线测试注入假时钟精确驱动时序） */
export interface ClickThroughScheduler {
  now(): number
  setInterval(fn: () => void, ms: number): unknown
  clearInterval(handle: unknown): void
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

const defaultScheduler: ClickThroughScheduler = {
  now: () => Date.now(),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (handle) => clearInterval(handle as NodeJS.Timeout),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout)
}

/** 接管状态：taken=窗口接收输入；yielded=输入让路（穿透） */
export type ClickThroughState = 'taken' | 'yielded'

/** 时序常量（集中可调；设计文档 §5.1：轮询 ~50ms、防抖"连续一致判定 + 最短间隔"） */
export interface ClickThroughTiming {
  /** YIELDED 态轮询间隔（ms） */
  POLL_INTERVAL_MS: number
  /** 防抖：状态切换需连续 N 次一致判定 */
  DEBOUNCE_STREAK: number
  /** 防抖：距上次切换的最短间隔（ms） */
  DEBOUNCE_MIN_INTERVAL_MS: number
  /** 防抖：单次报告的稳定确认窗口（ms）——渲染侧"变化才上报"语义的配套（见文件头对接说明 ①） */
  DEBOUNCE_CONFIRM_MS: number
  /** 脉冲周期（ms）：X11 缓存刷新用（见文件头实测备忘 ③） */
  PULSE_PERIOD_MS: number
  /** 脉冲时长（ms）：实测 ≥10ms 可靠，20ms 稳定 */
  PULSE_MS: number
}

export const CLICK_THROUGH_TIMING: ClickThroughTiming = {
  POLL_INTERVAL_MS: 50,
  DEBOUNCE_STREAK: 2,
  DEBOUNCE_MIN_INTERVAL_MS: 120,
  DEBOUNCE_CONFIRM_MS: 120,
  PULSE_PERIOD_MS: 200,
  PULSE_MS: 20
}

export interface ClickThroughDeps {
  win: ClickThroughWindow
  /** 光标坐标源（见 cursor-source.ts：Linux 首选 XI2 实时流；降级源 isLive=false 时配合脉冲） */
  cursorSource: ClickThroughCursorSource
  /** 调度器（缺省用全局定时器；测试注入） */
  scheduler?: ClickThroughScheduler
}

/** 状态机句柄（main.ts 持有：start / 清理 / 渲染回报转发） */
export interface ClickThrough {
  /** 启动（初值 YIELDED：不挡用户，首次滑入由轮询+渲染判定自然接管）；幂等 */
  start(): void
  /** 停止并解绑（退出/窗口销毁清理） */
  stop(): void
  /** 渲染侧命中判定回报（IPC 转发入口：IPC.PET_REPORT_HIT_TEST） */
  notifyReport(solid: boolean): void
  /** 当前状态（调试/测试观测） */
  getState(): ClickThroughState
}

/**
 * 创建输入接管状态机。
 *
 * 状态迁移（防抖=稳定证据：连续 DEBOUNCE_STREAK 次一致判定，或"单次报告 + DEBOUNCE_CONFIRM_MS
 * 确认窗口内无相反报告"——兼容渲染侧"变化才上报"语义，见文件头对接说明①；
 * 且距上次切换 ≥DEBOUNCE_MIN_INTERVAL_MS）：
 *   TAKEN  --渲染报 solid=false--> YIELDED（setIgnoreMouseEvents(true)）；
 *          另有几何守卫：连续读得"光标在窗口矩形外" → 自主让路（对接说明②）
 *   YIELDED --渲染报 solid=true--> TAKEN（setIgnoreMouseEvents(false)）
 * 守卫：窗口不可见 / 最小化 / 销毁 → 停轮询、状态复位 YIELDED（重新显示恢复轮询并立即脉冲）。
 */
export function createClickThrough(deps: ClickThroughDeps, timing: ClickThroughTiming = CLICK_THROUGH_TIMING): ClickThrough {
  const { win, cursorSource } = deps
  const sched = deps.scheduler ?? defaultScheduler

  /** 读取光标屏幕坐标；null = 坐标源暂无可信数据（如 XI2 首事件前）→ 本轮跳过 */
  const readCursor = (): Point | null => cursorSource.read()

  let state: ClickThroughState = 'yielded'
  let started = false
  let pollTimer: unknown = null
  let pulseTimer: unknown = null
  /** 下一次脉冲的到期时刻（-Infinity = 下一个 tick 立即脉冲） */
  let pulseDueAt = -Infinity
  /** 上一次推送的"光标是否在窗口内"（null=尚未推送过；出窗 null 仅推边沿） */
  let lastInside: boolean | null = null
  /** 防抖：当前候选判定值与其连续次数 */
  let candidate: boolean | null = null
  let streak = 0
  /** 防抖：稳定确认定时器（"报告 + 确认窗口"的确认半段，见文件头对接说明 ①） */
  let confirmTimer: unknown = null
  /** 上一次状态切换时刻（null=从未切换） */
  let lastSwitchAt: number | null = null

  /**
   * 应用输入让路开关。
   *
   * forward 取值按平台定（2026-10-16 移植修正）：
   *  - X11：转发本就无效（DDE 实测 `{forward:true}` 不转发 mousemove），取值无差别 → 保持 false；
   *  - Windows：**必须 true**。让路态下要把 mousemove 转发给渲染进程，否则渲染侧收不到任何
   *    指针事件——换用未实现 hitTest 的渲染器（three-d / part-animation）时，空气让路会
   *    自动退回 App.tsx 的旧悬停逻辑（见 pixel-hit-test.ts 的 active 条件），而旧逻辑正是靠转发来的
   *    mousemove 判定"滑回宠物身上"，转发被关掉就成了**永远收不回输入的穿透态**（宠物再也点不到）。
   *    与本平台 window/win32.ts 的 setClickThrough 保持同一取值。
   */
  const applyIgnore = (ignore: boolean): void => {
    const forward = isWindows
    win.setIgnoreMouseEvents(ignore, ignore ? { forward } : undefined)
  }

  const resetYieldedSide = (): void => {
    lastInside = null
    pulseDueAt = -Infinity
  }

  const cancelConfirm = (): void => {
    if (confirmTimer !== null) {
      sched.clearTimeout(confirmTimer)
      confirmTimer = null
    }
  }

  const stopPolling = (): void => {
    if (pollTimer !== null) {
      sched.clearInterval(pollTimer)
      pollTimer = null
    }
    if (pulseTimer !== null) {
      sched.clearTimeout(pulseTimer)
      pulseTimer = null
    }
    cancelConfirm()
  }

  /** 读取光标位置并推送窗口内坐标（窗内每 tick 推坐标；出窗仅边沿推一次 null） */
  const pushCursorPosition = (): void => {
    const p = readCursor()
    if (p === null) return // 坐标源暂无数据（如 XI2 首事件前）→ 本轮跳过
    const b = win.getBounds()
    const x = Math.round(p.x - b.x)
    const y = Math.round(p.y - b.y)
    const inside = x >= 0 && y >= 0 && x < b.width && y < b.height
    if (inside) {
      lastInside = true
      win.webContents.send(IPC_EVENTS.PET_POINTER_POS, { x, y })
    } else if (lastInside === true) {
      lastInside = false
      win.webContents.send(IPC_EVENTS.PET_POINTER_POS, null)
    }
  }

  /**
   * 脉冲：短暂关闭输入让路（让窗口在指针位于其上时收到真实事件、刷新 X11 光标缓存），
   * PULSE_MS 后回切让路；脉冲期间若已切 TAKEN（渲染报实体）则不再回切。
   */
  const firePulse = (): void => {
    applyIgnore(false)
    pulseTimer = sched.setTimeout(() => {
      pulseTimer = null
      if (!started || state !== 'yielded') return
      pushCursorPosition() // 脉冲刚结束：读一次新鲜值（此时缓存已刷新，若有事件）
      applyIgnore(true)
    }, timing.PULSE_MS)
  }

  const pollTick = (): void => {
    if (!started) return
    if (win.isDestroyed()) {
      stopInternal('destroyed')
      return
    }
    if (!win.isVisible() || win.isMinimized()) {
      pauseInternal('guard')
      return
    }
    // 仅让路态轮询（接管态窗口收真实事件，判定交渲染——本 tick 已被 stopPolling 停掉，此处双保险）
    if (state !== 'yielded') return
    // 轮询推送光标坐标（渲染判定）；非实时源（降级）附加周期脉冲刷新 X11 缓存
    if (!cursorSource.isLive()) {
      const now = sched.now()
      if (now - pulseDueAt >= timing.PULSE_PERIOD_MS) {
        pulseDueAt = now
        firePulse()
      }
    }
    pushCursorPosition()
  }

  const ensurePolling = (): void => {
    if (pollTimer !== null || !started || win.isDestroyed()) return
    pollTimer = sched.setInterval(pollTick, timing.POLL_INTERVAL_MS)
  }

  /** 守卫暂停：停轮询/停坐标源 + 状态复位 YIELDED（重新显示时不挡用户） */
  const pauseInternal = (reason: string): void => {
    stopPolling()
    cursorSource.stop() // 不可见时停坐标源（省开销；恢复时重启）
    if (state === 'taken') {
      state = 'yielded'
      lastSwitchAt = null
      applyIgnore(true)
    }
    candidate = null
    streak = 0
    resetYieldedSide()
    console.log(`[window/click-through] 守卫暂停（${reason}）：停轮询、状态复位 YIELDED`)
  }

  const stopInternal = (reason: string): void => {
    if (!started) return
    started = false
    stopPolling()
    cursorSource.stop()
    win.removeListener('show', onShow)
    win.removeListener('hide', onHide)
    win.removeListener('minimize', onMinimize)
    win.removeListener('restore', onRestore)
    console.log(`[window/click-through] 停止（${reason}）`)
  }

  const onShow = (): void => resumeInternal('shown')
  const onRestore = (): void => resumeInternal('restored')
  const onHide = (): void => pauseInternal('hidden')
  const onMinimize = (): void => pauseInternal('minimized')

  const resumeInternal = (reason: string): void => {
    if (!started || win.isDestroyed()) return
    if (state !== 'yielded') return // 暂停时已复位，恢复只从 YIELDED 开始
    pulseDueAt = -Infinity // 恢复后首个 tick 立即脉冲（降级源尽快刷新缓存；实时源无此路径）
    cursorSource.start()
    ensurePolling()
    console.log(`[window/click-through] 守卫恢复（${reason}）：重启轮询`)
  }

  /** 尝试状态切换（防抖：需满足最短间隔；不满足时保留候选，由确认定时器补足剩余时间再试） */
  const trySwitch = (target: ClickThroughState): void => {
    if (state === target) return
    const now = sched.now()
    if (lastSwitchAt !== null && now - lastSwitchAt < timing.DEBOUNCE_MIN_INTERVAL_MS) return
    state = target
    lastSwitchAt = now
    candidate = null
    streak = 0
    cancelConfirm()
    if (target === 'taken') {
      stopPolling() // 接管态窗口收真实事件：停轮询/脉冲，判定交渲染 mousemove 事件
      applyIgnore(false)
      console.log('[window/click-through] → TAKEN（接管输入，渲染事件驱动判定）')
    } else {
      applyIgnore(true)
      resetYieldedSide()
      // 给渲染侧的"状态已让路"信号：补推一次 null（渲染侧若把 null 视为重置判定去重，
      // 可消除"主进程状态变化但渲染判定值未变"的边界残留——见文件头对接说明 ②）
      win.webContents.send(IPC_EVENTS.PET_POINTER_POS, null)
      ensurePolling()
      console.log('[window/click-through] → YIELDED（输入让路，轮询 + 脉冲感知）')
    }
  }

  /**
   * "报告 + 确认窗口"的确认半段（见文件头对接说明 ①）：
   * DEBOUNCE_CONFIRM_MS 内候选未被相反报告推翻（= 渲染侧判定保持）→ 视为稳定证据，执行切换。
   */
  const onConfirm = (): void => {
    confirmTimer = null
    if (!started || candidate === null) return
    const target: ClickThroughState = candidate ? 'taken' : 'yielded'
    if (target === state) return
    const now = sched.now()
    if (lastSwitchAt !== null && now - lastSwitchAt < timing.DEBOUNCE_MIN_INTERVAL_MS) {
      // 距上次切换不足最短间隔：补足剩余时间后再确认
      confirmTimer = sched.setTimeout(onConfirm, timing.DEBOUNCE_MIN_INTERVAL_MS - (now - lastSwitchAt))
      return
    }
    trySwitch(target)
  }

  const scheduleConfirm = (): void => {
    cancelConfirm()
    confirmTimer = sched.setTimeout(onConfirm, timing.DEBOUNCE_CONFIRM_MS)
  }

  /**
   * 渲染侧命中判定回报（IPC 入口）。
   * 防抖两路（见文件头对接说明 ①）：
   *  - 密集报告：连续 DEBOUNCE_STREAK 次一致 → 直接尝试切换（仍受最短间隔约束）；
   *  - "变化才上报"（当前渲染侧实现）：单次报告 + 确认窗口（窗口内无相反报告即确认）。
   */
  const notifyReport = (solid: boolean): void => {
    if (!started || win.isDestroyed()) return
    const target: ClickThroughState = solid ? 'taken' : 'yielded'
    if (target === state) {
      // 与当前状态一致的回报：清零候选（维护"稳定"语义）
      candidate = null
      streak = 0
      cancelConfirm()
      return
    }
    if (candidate === solid) {
      streak += 1 // 同候选重复报告：不重置确认窗口
    } else {
      candidate = solid
      streak = 1
      scheduleConfirm() // 候选变化 → 重新开始稳定确认窗口
    }
    if (streak >= timing.DEBOUNCE_STREAK) trySwitch(target)
  }

  const start = (): void => {
    if (started || win.isDestroyed()) return
    started = true
    state = 'yielded'
    lastSwitchAt = null
    candidate = null
    streak = 0
    cancelConfirm()
    resetYieldedSide()
    applyIgnore(true) // 初值 YIELDED：不挡用户
    cursorSource.start()
    win.on('show', onShow)
    win.on('hide', onHide)
    win.on('minimize', onMinimize)
    win.on('restore', onRestore)
    if (win.isVisible() && !win.isMinimized()) ensurePolling()
    console.log('[window/click-through] 启动：初值 YIELDED（轮询 + 坐标源）')
  }

  const stop = (): void => stopInternal('stopped')

  return { start, stop, notifyReport, getState: () => state }
}
