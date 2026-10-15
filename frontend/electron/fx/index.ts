/**
 * 魔法球捕获动画域（fx）：**球窗**（透明小窗，"球"本体）+ 隐藏/显示两个动画流程的时序编排。
 *
 * 设计（详见 frontend/fx-report.md；方案沿革：全屏透明层已弃用——避免遮挡用户其它操作）：
 * - **球窗**：一个 ballWindowSize×ballWindowSize 的透明小窗（与宠物窗同源的窗口技术：
 *   transparent + frame:false + alwaysOnTop(层级 screen-saver) + skipTaskbar + type:'toolbar'
 *   （DDE Dock 不出现窗口格，照 linux.ts 先例）+ focusable:false（不抢焦点）+
 *   **全点击穿透**（setIgnoreMouseEvents(true)——窗口不吃任何鼠标事件，不影响用户操作）；
 * - **飞行 = 移动球窗本身**（setBounds 缓动，复用 window/move.ts 风格）：从托盘锚点滑到
 *   宠物窗口中心；"跨屏/长距离飞行"都只是移动这个小窗；
 * - **锚点自动定位**：托盘兔头图标的屏幕坐标由 `fx/anchor.ts` 每轮动画前"抓屏 + 模板匹配"
 *   现场定位（图标位置无 API 可查且会漂移），失败回退兜底配置 TRAY_ANCHOR（见 fx/config.ts）；
 * - 球窗内容（src/fx/main.ts）：Canvas 2D 程序化绘制魔法球（球固定在窗口中心）；
 *   拖尾/光晕按窗口尺寸收敛（超出窗口的部分会被裁，视觉设计已按此约束做）；
 * - **主进程是唯一指挥**：时序、球窗/宠物窗的移动缩放、指令下发全在这里；
 *   渲染页只负责"画"，不做时间判断；
 * - **锁**：同一时刻只允许一个动画（动画中再次触发显/隐直接忽略）；
 * - **退出不播动画**：本域不参与 app.quit 链路（before-quit 后窗口直接销毁）；
 * - **兜底**：等待 fx 页就绪有超时；整个流程有 totalTimeoutMs 看门狗；异常/超时一律走
 *   try/catch/finally 保证结果语义（隐藏 = 一定 hide；显示 = 一定 show 且归位）。
 */
import { app, BrowserWindow, ipcMain, screen } from 'electron'
import { join } from 'node:path'
import { IPC_EVENTS, IPC_FX, type FxCommand, type FxPetReactionPayload } from '../ipc/channels'
import { FX_CONFIG } from './config'
import { locateTrayAnchor } from './anchor'
import type { Point, Rect, Size } from '../window'

const isDev = !app.isPackaged

/** 逐帧间隔（ms）：≈60fps，与 window/move.ts 同款做法（主进程无 rAF，用 setInterval 近似） */
const FRAME_INTERVAL_MS = 16

// ------------------------------------------------------------------ 状态

/** 球窗（懒创建；首次隐藏/显示时建立，之后复用——hide 而非 destroy，下次秒开） */
let ballWin: BrowserWindow | null = null
/** fx 页已就绪标志（收到 fx:ready 后置位；窗口重建后复位） */
let fxReady = false
/** 等待就绪的回调队列（fx 页加载完成时统一唤醒） */
let readyWaiters: Array<() => void> = []
/** 动画锁：true = 有动画进行中（期间新的显/隐请求直接忽略） */
let busy = false
/** 宠物隐藏前的"家"（显示动画归位用；隐藏动画开始时记录） */
let stashedBounds: Rect | null = null
/** ipcMain 就绪监听是否已注册（只注册一次） */
let readyListenerInstalled = false

/** 流程上下文：看门狗超时置 aborted，各阶段在 await 后检查并提前退出 */
interface FlowContext {
  aborted: boolean
}

// ------------------------------------------------------------------ 工具

/** 整段睡眠（可被 ctx.aborted 提前唤醒；调用方在 await 后用 assertLive 检查） */
function sleep(ms: number, ctx: FlowContext): Promise<void> {
  const STEP = 50
  return new Promise((resolve) => {
    const t0 = Date.now()
    const tick = (): void => {
      if (ctx.aborted || Date.now() - t0 >= ms) {
        resolve()
        return
      }
      setTimeout(tick, Math.min(STEP, ms))
    }
    if (ms <= 0) resolve()
    else setTimeout(tick, Math.min(STEP, ms))
  })
}

/** 中止检查：看门狗超时后在各阶段边界抛出，由外层 catch 兜底 */
function assertLive(ctx: FlowContext): void {
  if (ctx.aborted) throw new Error('fx 动画超时中止（看门狗）')
}

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t

/**
 * 缓动：easeInOut 三次（照参考 magic-flight：u<0.5 ? 4u³ : 1-(-2u+2)³/2）——
 * 飞行的起停都柔和，中段快（"腾空-滑翔-落点"的节奏）。
 */
function easeInOutCubic(u: number): number {
  return u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2
}

/** 缓动：easeOutCubic（快速冲出、缓慢收尾——显示方向"放大归位"用） */
function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3)
}

/**
 * 二次贝塞尔"拱线"（照参考 magic-flight）：控制点取起点/终点中点、向上抬 arc，
 * arc = clamp(距离 × arcFactor, arcMin, arcMax)；另把控制点 clamp 在工作区顶部
 * 安全边距之下（防"向上拱"把球拱出屏顶导致中途不可见）。
 * 返回 u∈[0,1] → 屏幕坐标。
 */
function makeArcPath(from: Point, to: Point, wa: Rect): (u: number) => Point {
  const dist = Math.hypot(to.x - from.x, to.y - from.y)
  const arc = Math.min(FX_CONFIG.arcMax, Math.max(FX_CONFIG.arcMin, dist * FX_CONFIG.arcFactor))
  const mid = {
    x: (from.x + to.x) / 2,
    y: Math.max(wa.y + FX_CONFIG.arcTopMargin, (from.y + to.y) / 2 - arc)
  }
  return (u: number) => {
    const v = 1 - u
    return {
      x: v * v * from.x + 2 * v * u * mid.x + u * u * to.x,
      y: v * v * from.y + 2 * v * u * mid.y + u * u * to.y
    }
  }
}

const centerOf = (r: Rect): Point => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 })

/** 以 center 为中心的球窗（或缩形态窗口）矩形（整数） */
function boundsAround(center: Point, width: number, height: number): Rect {
  const w = Math.max(2, Math.round(width))
  const h = Math.max(2, Math.round(height))
  return { x: Math.round(center.x - w / 2), y: Math.round(center.y - h / 2), width: w, height: h }
}

const rectStr = (r: Rect): string => `${r.x},${r.y} ${r.width}x${r.height}`
const ptStr = (p: Point): string => `${Math.round(p.x)},${Math.round(p.y)}`

// ------------------------------------------------------------------ 球窗

/** 注册 fx 页就绪监听（一次）：fx 页 preload 加载完成后 send fx:ready */
function installReadyListener(): void {
  if (readyListenerInstalled) return
  readyListenerInstalled = true
  ipcMain.on(IPC_FX.READY, () => {
    fxReady = true
    const waiters = readyWaiters
    readyWaiters = []
    waiters.forEach((fn) => fn())
  })
}

/** 等待 fx 页就绪（带超时；超时返回 false → 调用方降级为直接 show/hide） */
function waitFxReady(timeoutMs: number): Promise<boolean> {
  if (fxReady) return Promise.resolve(true)
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      readyWaiters = readyWaiters.filter((fn) => fn !== onReady)
      resolve(false)
    }, timeoutMs)
    const onReady = (): void => {
      clearTimeout(timer)
      resolve(true)
    }
    readyWaiters.push(onReady)
  })
}

/**
 * 创建球窗（懒创建；窗口技术照宠物窗 linux.ts 先例）。
 * 多屏适配：球窗"飞到哪就把自己挪到哪"，屏幕选择天然落在目标坐标所在屏，
 * 无需覆盖特定显示器（原全屏方案的多屏限制在球窗方案下自动消失）。
 */
function createBallWindow(): BrowserWindow {
  const size = FX_CONFIG.ballWindowSize
  const win = new BrowserWindow({
    width: size,
    height: size,
    transparent: true,
    backgroundColor: '#00000000',
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    hasShadow: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    // DDE(Dock) 忽略 skipTaskbar——沿用宠物窗口实测结论：type:'toolbar' 可让 Dock 不出现窗口格
    type: 'toolbar',
    // 动画窗不做交互、不抢焦点（否则会打断用户当前输入）
    focusable: false,
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  })
  // 层级抬到最高（球要盖在宠物窗口之上表现"吸进/放出"；DDE/KWin 上 screen-saver 为顶层）
  win.setAlwaysOnTop(true, 'screen-saver')
  // 全点击穿透：球窗不吃任何鼠标事件——飞过/停在托盘附近都不会挡住用户操作
  // （X11 上 ignoreMouseEvents 对鼠标透传有效；verify-report 已知"不转发 mousemove"——本窗口不需要 hover，无影响）
  win.setIgnoreMouseEvents(true)

  win.on('closed', () => {
    ballWin = null
    fxReady = false
  })

  fxReady = false
  if (isDev && process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/fx.html`)
  } else {
    void win.loadFile(join(__dirname, '../renderer/fx.html'))
  }
  console.log(`[fx] 球窗已创建（${size}x${size}，全穿透）`)
  return win
}

/** 取（必要时创建）球窗 */
function ensureBallWindow(): BrowserWindow {
  installReadyListener()
  if (ballWin && !ballWin.isDestroyed()) return ballWin
  ballWin = createBallWindow()
  return ballWin
}

/** 下发动画指令（窗口/页面异常时静默忽略） */
function sendCommand(win: BrowserWindow, cmd: FxCommand): void {
  if (win.isDestroyed() || win.webContents.isDestroyed()) return
  win.webContents.send(IPC_FX.COMMAND, cmd)
}

/** 通知宠物窗口渲染侧播放"被抓/被放"反应（隐藏窗口也能收到，渲染进程仍存活） */
function sendPetReaction(win: BrowserWindow, kind: FxPetReactionPayload['kind']): void {
  if (win.isDestroyed() || win.webContents.isDestroyed()) return
  const payload: FxPetReactionPayload = { kind }
  win.webContents.send(IPC_EVENTS.PET_FX_REACTION, payload)
}

/** 应用退出时销毁球窗（走 will-quit；正常退出路径不播动画、也不等待动画） */
export function destroyFx(): void {
  if (ballWin && !ballWin.isDestroyed()) ballWin.destroy()
  ballWin = null
  fxReady = false
  readyWaiters = []
}

// ------------------------------------------------------------------ 窗口缓动（移动 + 可选缩放）

/**
 * 逐帧缓动窗口 bounds（位置与尺寸同时插值）。
 * @param ease    原始进度 p∈[0,1] → 缓动进度
 * @param frameAt 缓动进度 e∈[0,1] → 本帧 bounds
 * 注：动画期间 fx 流程独占窗口操作（锁保证），不做抢占/取消（看门狗中止时提前退出）。
 */
function animateWindowBounds(
  win: BrowserWindow,
  durationMs: number,
  ease: (p: number) => number,
  frameAt: (e: number) => Rect,
  ctx: FlowContext
): Promise<void> {
  return new Promise((resolve) => {
    if (win.isDestroyed() || durationMs <= 0) {
      if (!win.isDestroyed()) win.setBounds(frameAt(1))
      resolve()
      return
    }
    const t0 = Date.now()
    const timer = setInterval(() => {
      if (ctx.aborted || win.isDestroyed()) {
        clearInterval(timer)
        resolve()
        return
      }
      const p = Math.min(1, (Date.now() - t0) / durationMs)
      win.setBounds(frameAt(ease(p)))
      if (p >= 1) {
        clearInterval(timer)
        resolve()
      }
    }, FRAME_INTERVAL_MS)
  })
}

/** 球窗沿拱线从 from 飞到 to（照参考：easeInOut 三次 × 二次贝塞尔拱线） */
function flyBallArc(
  ball: BrowserWindow,
  from: Point,
  to: Point,
  wa: Rect,
  durationMs: number,
  ctx: FlowContext
): Promise<void> {
  const path = makeArcPath(from, to, wa)
  const size = FX_CONFIG.ballWindowSize
  return animateWindowBounds(
    ball,
    durationMs,
    easeInOutCubic,
    (e) => boundsAround(path(e), size, size),
    ctx
  )
}

/**
 * 回程：球窗与缩小态的宠物窗沿**同一条拱线**同步飞行（单计时循环同时 setBounds——
 * 双计时器会有 1 帧级 jitter，高速段会看出球与宠物错位）。
 */
function flyBothArc(
  ball: BrowserWindow,
  pet: BrowserWindow,
  from: Point,
  to: Point,
  wa: Rect,
  petSize: Size,
  durationMs: number,
  ctx: FlowContext
): Promise<void> {
  const path = makeArcPath(from, to, wa)
  const size = FX_CONFIG.ballWindowSize
  return new Promise((resolve) => {
    if (durationMs <= 0 || ball.isDestroyed()) {
      resolve()
      return
    }
    const t0 = Date.now()
    const timer = setInterval(() => {
      if (ctx.aborted || ball.isDestroyed()) {
        clearInterval(timer)
        resolve()
        return
      }
      const p = Math.min(1, (Date.now() - t0) / durationMs)
      const c = path(easeInOutCubic(p))
      ball.setBounds(boundsAround(c, size, size))
      if (!pet.isDestroyed()) pet.setBounds(boundsAround(c, petSize.width, petSize.height))
      if (p >= 1) {
        clearInterval(timer)
        resolve()
      }
    }, FRAME_INTERVAL_MS)
  })
}

// ------------------------------------------------------------------ 隐藏流程

/**
 * 隐藏动画：① 球（空）沿拱线从托盘飞到宠物中心 → ② 抵达爆散（捕获：宠物原地缩小 +
 * 挣扎反应，球窗播爆散）→ ③ 球与缩小态的宠物沿同一条拱线**一起**飞回托盘 →
 * ④ 到达后宠物 hide，球淡出收窗。
 */
async function hideFlow(
  win: BrowserWindow,
  ball: BrowserWindow,
  wa: Rect,
  anchor: Point,
  ctx: FlowContext
): Promise<void> {
  const t0 = Date.now()
  const stamp = (msg: string): void => console.log(`[fx] t=${Date.now() - t0}ms ${msg}`)

  const stash = win.getBounds()
  stashedBounds = stash
  const petCenter = centerOf(stash)
  const size = FX_CONFIG.ballWindowSize
  stamp(`隐藏动画开始：宠物 ${rectStr(stash)}，锚点 ${ptStr(anchor)}`)

  // ① 球（空载）沿拱线从托盘飞到宠物中心
  ball.setBounds(boundsAround(anchor, size, size))
  sendCommand(ball, { type: 'flight', cargo: false })
  await flyBallArc(ball, anchor, petCenter, wa, FX_CONFIG.flightMs, ctx)
  assertLive(ctx)
  stamp(`球到达宠物（flight ${FX_CONFIG.flightMs}ms）`)

  // ② 抵达爆散（捕获）：球窗播爆散粒子/光晕/扩散环 + 渲染侧挣扎反应 + 宠物窗口原地缩小
  sendCommand(ball, { type: 'capture-burst', holdMs: FX_CONFIG.captureMs })
  sendPetReaction(win, 'captured')
  const start = win.getBounds()
  const targetW = Math.max(2, Math.round(start.width * FX_CONFIG.shrinkScale))
  const targetH = Math.max(2, Math.round(start.height * FX_CONFIG.shrinkScale))
  await animateWindowBounds(
    win,
    FX_CONFIG.captureMs,
    easeInOutCubic,
    (e) => boundsAround(petCenter, lerp(start.width, targetW, e), lerp(start.height, targetH, e)),
    ctx
  )
  assertLive(ctx)
  stamp(`捕获完成（宠物缩至 ${FX_CONFIG.shrinkScale}×，${rectStr(win.getBounds())}）`)

  // ③ 球拎着缩小态的宠物沿同一条拱线一起飞回托盘（球窗盖在宠物上=吸进球里）
  const petShrunk = win.getBounds()
  sendCommand(ball, { type: 'flight', cargo: true })
  await flyBothArc(
    ball,
    win,
    petCenter,
    anchor,
    wa,
    { width: petShrunk.width, height: petShrunk.height },
    FX_CONFIG.returnMs,
    ctx
  )
  assertLive(ctx)
  stamp(`到达托盘锚点（return ${FX_CONFIG.returnMs}ms）`)

  // ④ 宠物 hide（此刻它已在托盘处的缩小态）；球淡出收窗
  win.hide()
  sendCommand(ball, { type: 'fade-out', durationMs: FX_CONFIG.fadeMs })
  await sleep(FX_CONFIG.fadeMs, ctx)
  stamp('隐藏动画完成')
}

// ------------------------------------------------------------------ 显示流程

/**
 * 显示动画（隐藏的反向）：① 球（载着宠物剪影）从托盘飞到原位中心 →
 * ② 到达后宠物窗口在原位以缩小态出现 → 爆闪释放 + 放大归位 + 渲染侧落地 Q 弹 →
 * ③ 球淡出收窗。
 */
async function showFlow(
  win: BrowserWindow,
  ball: BrowserWindow,
  wa: Rect,
  anchor: Point,
  ctx: FlowContext
): Promise<void> {
  const t0 = Date.now()
  const stamp = (msg: string): void => console.log(`[fx] t=${Date.now() - t0}ms ${msg}`)

  // 原位：优先用隐藏时记录的家；缺失（异常路径）时退回当前 bounds
  const home = stashedBounds ?? win.getBounds()
  const homeCenter = centerOf(home)
  const size = FX_CONFIG.ballWindowSize
  stamp(`显示动画开始：原位 ${rectStr(home)}，锚点 ${ptStr(anchor)}`)

  // ① 球（载宠物剪影）沿拱线从托盘飞到原位中心（飞行期间宠物窗口保持隐藏，由球"携带"）
  ball.setBounds(boundsAround(anchor, size, size))
  sendCommand(ball, { type: 'flight', cargo: true })
  await flyBallArc(ball, anchor, homeCenter, wa, FX_CONFIG.flightMs, ctx)
  assertLive(ctx)
  stamp(`球到达原位（flight ${FX_CONFIG.flightMs}ms）`)

  // ② 释放：宠物窗口以原位缩小态出现（不抢焦点）→ 爆闪 + 落地 Q 弹 + 放大归位
  const start = boundsAround(homeCenter, home.width * FX_CONFIG.shrinkScale, home.height * FX_CONFIG.shrinkScale)
  win.setBounds(start)
  win.showInactive()
  sendCommand(ball, { type: 'release-burst' })
  sendPetReaction(win, 'released')
  await animateWindowBounds(
    win,
    FX_CONFIG.releaseMs,
    easeOutCubic,
    (e) => boundsAround(homeCenter, lerp(start.width, home.width, e), lerp(start.height, home.height, e)),
    ctx
  )
  assertLive(ctx)
  stashedBounds = null
  stamp(`放大归位完成（${rectStr(win.getBounds())}）`)

  // ③ 球淡出收窗
  sendCommand(ball, { type: 'fade-out', durationMs: FX_CONFIG.fadeMs })
  await sleep(FX_CONFIG.fadeMs, ctx)
  stamp('显示动画完成')
}

// ------------------------------------------------------------------ 对外流程（锁 + 兜底）

/** 动画公共外壳：锁 → 就绪等待 → 流程 → 兜底（保证结果语义） */
async function runFlow(win: BrowserWindow, direction: 'hide' | 'show', degrade: () => void): Promise<void> {
  const label = direction === 'hide' ? '隐藏' : '显示'
  if (win.isDestroyed()) return
  if (busy) {
    console.log(`[fx] 动画进行中，忽略本次${label}请求`)
    return
  }
  busy = true
  const ctx: FlowContext = { aborted: false }
  const watchdog = setTimeout(() => {
    ctx.aborted = true
    console.warn(`[fx] ${label}动画超时（>${FX_CONFIG.totalTimeoutMs}ms），看门狗中止`)
  }, FX_CONFIG.totalTimeoutMs)
  try {
    const ball = ensureBallWindow()
    // fx 页就绪等待 与 锚点自动定位（抓屏+模板匹配）并行 —— 降低"按下到球起飞"的感知延迟；
    // 定位失败/超时都返回兜底值，绝不影响动画播放
    const [ready, anchorRes] = await Promise.all([
      waitFxReady(FX_CONFIG.readyTimeoutMs),
      locateTrayAnchor()
    ])
    if (!ready) {
      console.warn(`[fx] 动画页未就绪（>${FX_CONFIG.readyTimeoutMs}ms），本次降级为直接${label}`)
      degrade()
      return
    }
    sendCommand(ball, { type: 'reset' })
    ball.showInactive()
    const wa = screen.getPrimaryDisplay().workArea
    const anchor: Point = { x: anchorRes.x, y: anchorRes.y }
    if (direction === 'hide') await hideFlow(win, ball, wa, anchor, ctx)
    else await showFlow(win, ball, wa, anchor, ctx)
  } catch (err) {
    console.error(`[fx] ${label}动画异常，兜底直接${label}：`, err)
    if (!win.isDestroyed()) {
      if (direction === 'hide') {
        win.hide()
      } else {
        // 显示方向异常兜底：一定可见 + 归位（stash 有则回原位）
        if (stashedBounds) win.setBounds(stashedBounds)
        if (!win.isVisible()) win.showInactive()
      }
    }
  } finally {
    clearTimeout(watchdog)
    if (!win.isDestroyed()) {
      // 结果语义兜底（幂等）：隐藏方向一定不可见；显示方向一定可见
      if (direction === 'hide' && win.isVisible()) win.hide()
      if (direction === 'show' && !win.isVisible()) win.showInactive()
    }
    // 球窗收窗（异常/超时路径也要收，防残留一个飘着的球）
    if (ballWin && !ballWin.isDestroyed() && ballWin.isVisible()) ballWin.hide()
    busy = false
  }
}

/** 隐藏流程：托盘"隐藏宠物"、Alt+F4 关窗拦截、单击切换等路径统一调用 */
export function runHideAnimation(win: BrowserWindow): Promise<void> {
  if (!FX_CONFIG.ENABLED) {
    win.hide()
    return Promise.resolve()
  }
  return runFlow(win, 'hide', () => win.hide())
}

/** 显示流程：托盘菜单"显示宠物"、托盘单击等路径统一调用 */
export function runShowAnimation(win: BrowserWindow): Promise<void> {
  if (!FX_CONFIG.ENABLED) {
    win.showInactive()
    return Promise.resolve()
  }
  return runFlow(win, 'show', () => {
    // 降级：瞬时显示（并发进行归位——stash 存在时窗口当前在缩小态）
    if (stashedBounds && !win.isDestroyed()) win.setBounds(stashedBounds)
    win.showInactive()
  })
}
