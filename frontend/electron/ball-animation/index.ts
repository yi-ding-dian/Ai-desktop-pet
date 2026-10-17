/**
 * 魔法球捕获动画域（fx）：**球窗**（透明小窗，"球"本体）+ 隐藏/显示/移动三个动画流程的时序编排。
 *
 * 设计（详见 docs/reports/frontend/2026-10-15-ball-animation.md；方案沿革：全屏透明层已弃用——避免遮挡用户其它操作）：
 * - **球窗**：一个 ballWindowSize×ballWindowSize 的透明小窗（与宠物窗同源的窗口技术：
 *   transparent + frame:false + alwaysOnTop(层级 screen-saver) + skipTaskbar + type:'toolbar'
 *   （DDE Dock 不出现窗口格，照 linux.ts 先例）+ focusable:false（不抢焦点）+
 *   **全点击穿透**（setIgnoreMouseEvents(true)——窗口不吃任何鼠标事件，不影响用户操作）；
 * - **飞行 = 移动球窗本身**（setBounds 缓动，复用 window/move.ts 风格）：从托盘锚点滑到
 *   宠物窗口中心；"跨屏/长距离飞行"都只是移动这个小窗；
 * - **移动（relocate，设置向导）按距离分档**（2026-10-16 用户定稿）：
 *   远距（≥ relocateMagicMinPx）→ 完整魔法：球**在宠物所在处原地凝聚**（spawn 指令，
 *   relocateSpawnMs）→ 爆闪捕获 → 携宠沿拱线飞行 → 释放（不经过托盘锚点）；近距
 *   （< 上限）→ 平滑移位（relocateGlideMs 小弧滑行，无球无爆闪）/ 太近
 *   （< relocateNearStepPx）直接落位；托盘隐藏/显示（hide/show）的托盘进出语义不变；
 * - **锚点定位**：优先托盘域注入的 `tray.getBounds()`（Windows 零延迟；图标在 overflow 时用
 *   任务栏右下角兜底）；没有提供者（Linux/macOS）才走 `ball-animation/anchor.ts` 的抓屏 + 模板匹配，
 *   失败回退兜底配置 TRAY_ANCHOR（见 ball-animation/config.ts）；
 * - 球窗内容（src/ball-animation/main.ts）：Canvas 2D 程序化绘制魔法球（球固定在窗口中心）；
 *   拖尾/光晕按窗口尺寸收敛（超出窗口的部分会被裁，视觉设计已按此约束做）；
 * - **主进程是唯一指挥**：时序、球窗/宠物窗的移动缩放、指令下发全在这里；
 *   渲染页只负责"画"，不做时间判断；
 * - **锁**：同一时刻只允许一个动画（隐藏/显示动画中再次触发显/隐直接忽略）；
 *   **移动（relocate，设置向导）例外**——入位/回位不可静默丢失：先等锁空闲（上限见
 *   BALL_ANIMATION_CONFIG.relocateBusyWaitMs），超时才放弃；
 * - **退出不播动画**：本域不参与 app.quit 链路（before-quit 后窗口直接销毁）；
 * - **兜底**：等待 动画页就绪有超时；整个流程有 totalTimeoutMs 看门狗；异常/超时一律走
 *   try/catch/finally 保证结果语义（隐藏 = 一定 hide；显示 = 一定 show 且归位）。
 */
import { app, BrowserWindow, ipcMain, screen } from 'electron'
import { join } from 'node:path'
import { IPC_EVENTS, IPC_BALL_ANIMATION, type BallAnimationCommand, type BallAnimationPetReactionPayload } from '../ipc/channels'
import { BALL_ANIMATION_CONFIG } from './config'
import { locateTrayAnchor } from './anchor'
import type { Point, Rect, Size } from '../window'

const isDev = !app.isPackaged

/** 逐帧间隔（ms）：≈60fps，与 window/move.ts 同款做法（主进程无 rAF，用 setInterval 近似） */
const FRAME_INTERVAL_MS = 16

// ------------------------------------------------------------------ 状态

/** 球窗（懒创建；首次隐藏/显示时建立，之后复用——hide 而非 destroy，下次秒开） */
let ballWin: BrowserWindow | null = null
/** 动画页已就绪标志（收到 ball-animation:ready 后置位；窗口重建后复位） */
let fxReady = false
/** 等待就绪的回调队列（动画页加载完成时统一唤醒） */
let readyWaiters: Array<() => void> = []
/** 动画锁：true = 有动画进行中（期间新的显/隐请求直接忽略） */
let busy = false
/** 宠物隐藏前的"家"（显示动画归位用；隐藏动画开始时记录） */
let stashedBounds: Rect | null = null
/** ipcMain 就绪监听是否已注册（只注册一次） */
let readyListenerInstalled = false
/**
 * 托盘锚点提供者（托盘域注册）：Windows 用 `tray.getBounds()`（零延迟）或任务栏角落兜底；
 * 返回 null = 走 `locateTrayAnchor()` 抓屏模板匹配（Linux 的既有路径）。
 *
 * 为什么需要：抓屏 + 模板匹配在 Windows 175% 缩放下实测 **2124ms** 且模板未命中
 * （Windows 托盘图标缩放/overflow 渲染与 Linux 模板不同）——右键托盘菜单、隐藏/显示动画
 * 每次都要等这 2 秒，用户感知就是"卡"。托盘域有 tray 实例，能零成本拿到图标 bounds，
 * 不该让动画域反复抓屏。
 */
type TrayAnchorProvider = () => Point | null
let trayAnchorProvider: TrayAnchorProvider | null = null

/** 注册托盘锚点提供者（托盘创建时调用；传 null 撤销） */
export function setTrayAnchorProvider(provider: TrayAnchorProvider | null): void {
  trayAnchorProvider = provider
}

/** 解析动画锚点：优先托盘域提供者；未注册/返回 null 时退回抓屏模板匹配 */
async function resolveTrayAnchorPoint(): Promise<Point> {
  const provided = trayAnchorProvider?.()
  if (provided) return provided
  const res = await locateTrayAnchor()
  return { x: res.x, y: res.y }
}

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
  const arc = Math.min(BALL_ANIMATION_CONFIG.arcMax, Math.max(BALL_ANIMATION_CONFIG.arcMin, dist * BALL_ANIMATION_CONFIG.arcFactor))
  const mid = {
    x: (from.x + to.x) / 2,
    y: Math.max(wa.y + BALL_ANIMATION_CONFIG.arcTopMargin, (from.y + to.y) / 2 - arc)
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

/** 注册 动画页就绪监听（一次）：动画页 preload 加载完成后 send ball-animation:ready */
function installReadyListener(): void {
  if (readyListenerInstalled) return
  readyListenerInstalled = true
  ipcMain.on(IPC_BALL_ANIMATION.READY, () => {
    fxReady = true
    const waiters = readyWaiters
    readyWaiters = []
    waiters.forEach((fn) => fn())
  })
}

/** 等待 动画页就绪（带超时；超时返回 false → 调用方降级为直接 show/hide） */
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
  const size = BALL_ANIMATION_CONFIG.ballWindowSize
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
    void win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/ball-animation.html`)
  } else {
    void win.loadFile(join(__dirname, '../renderer/ball-animation.html'))
  }
  console.log(`[ball-animation] 球窗已创建（${size}x${size}，全穿透）`)
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
function sendCommand(win: BrowserWindow, cmd: BallAnimationCommand): void {
  if (win.isDestroyed() || win.webContents.isDestroyed()) return
  win.webContents.send(IPC_BALL_ANIMATION.COMMAND, cmd)
}

/** 通知宠物窗口渲染侧播放"被抓/被放"反应（隐藏窗口也能收到，渲染进程仍存活） */
function sendPetReaction(win: BrowserWindow, kind: BallAnimationPetReactionPayload['kind']): void {
  if (win.isDestroyed() || win.webContents.isDestroyed()) return
  const payload: BallAnimationPetReactionPayload = { kind }
  win.webContents.send(IPC_EVENTS.PET_FX_REACTION, payload)
}

/** 应用退出时销毁球窗（走 will-quit；正常退出路径不播动画、也不等待动画） */
export function destroyBallAnimation(): void {
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
  const size = BALL_ANIMATION_CONFIG.ballWindowSize
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
  const size = BALL_ANIMATION_CONFIG.ballWindowSize
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

// ------------------------------------------------------------------ 流程原子（hide/show/relocate 公用）

/**
 * 球窗从托盘锚点起飞（空载或载宠物剪影）沿拱线飞抵某中心坐标（flightMs）。
 * 去程（空载捕获）与回程/显示（载宠）共用；调用方负责后续阶段的指令与断言。
 */
async function flyBallFromAnchor(
  ball: BrowserWindow,
  anchor: Point,
  to: Point,
  wa: Rect,
  cargo: boolean,
  ctx: FlowContext
): Promise<void> {
  ball.setBounds(boundsAround(anchor, BALL_ANIMATION_CONFIG.ballWindowSize, BALL_ANIMATION_CONFIG.ballWindowSize))
  sendCommand(ball, { type: 'flight', cargo })
  await flyBallArc(ball, anchor, to, wa, BALL_ANIMATION_CONFIG.flightMs, ctx)
}

/**
 * 捕获段（hide/relocate 公用）：球窗原地播捕获爆闪 + 宠物渲染侧"被抓"反应 +
 * 宠物窗口以 petCenter 为锚**原地缩小**到 shrinkScale。
 * 只改几何不改可见性——hide 的"随后隐藏"由调用方负责（relocate 则继续飞行）。
 */
async function capturePetAt(
  win: BrowserWindow,
  ball: BrowserWindow,
  petCenter: Point,
  ctx: FlowContext
): Promise<void> {
  sendCommand(ball, { type: 'capture-burst', holdMs: BALL_ANIMATION_CONFIG.captureMs })
  sendPetReaction(win, 'captured')
  const start = win.getBounds()
  const targetW = Math.max(2, Math.round(start.width * BALL_ANIMATION_CONFIG.shrinkScale))
  const targetH = Math.max(2, Math.round(start.height * BALL_ANIMATION_CONFIG.shrinkScale))
  await animateWindowBounds(
    win,
    BALL_ANIMATION_CONFIG.captureMs,
    easeInOutCubic,
    (e) => boundsAround(petCenter, lerp(start.width, targetW, e), lerp(start.height, targetH, e)),
    ctx
  )
}

/**
 * 释放段（show/relocate 公用）：宠物窗口以 home 中心缩小态出现（不抢焦点）→
 * 球窗释放爆闪 + 宠物渲染侧"落地"反应 → 宠物放大归位到 home（原尺寸矩形）。
 */
async function releasePetAt(
  win: BrowserWindow,
  ball: BrowserWindow,
  home: Rect,
  ctx: FlowContext
): Promise<void> {
  const homeCenter = centerOf(home)
  const start = boundsAround(
    homeCenter,
    home.width * BALL_ANIMATION_CONFIG.shrinkScale,
    home.height * BALL_ANIMATION_CONFIG.shrinkScale
  )
  win.setBounds(start)
  win.showInactive()
  sendCommand(ball, { type: 'release-burst' })
  sendPetReaction(win, 'released')
  await animateWindowBounds(
    win,
    BALL_ANIMATION_CONFIG.releaseMs,
    easeOutCubic,
    (e) => boundsAround(homeCenter, lerp(start.width, home.width, e), lerp(start.height, home.height, e)),
    ctx
  )
}

/** 收尾：球窗淡出（异常/超时路径的收窗由 runFlow 的 finally 兜底） */
async function fadeBallOut(ball: BrowserWindow, ctx: FlowContext): Promise<void> {
  sendCommand(ball, { type: 'fade-out', durationMs: BALL_ANIMATION_CONFIG.fadeMs })
  await sleep(BALL_ANIMATION_CONFIG.fadeMs, ctx)
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
  const stamp = (msg: string): void => console.log(`[ball-animation] t=${Date.now() - t0}ms ${msg}`)

  const stash = win.getBounds()
  stashedBounds = stash
  const petCenter = centerOf(stash)
  stamp(`隐藏动画开始：宠物 ${rectStr(stash)}，锚点 ${ptStr(anchor)}`)

  // ① 球（空载）沿拱线从托盘飞到宠物中心
  await flyBallFromAnchor(ball, anchor, petCenter, wa, false, ctx)
  assertLive(ctx)
  stamp(`球到达宠物（flight ${BALL_ANIMATION_CONFIG.flightMs}ms）`)

  // ② 抵达爆散（捕获）：球窗播爆散粒子/光晕/扩散环 + 渲染侧挣扎反应 + 宠物窗口原地缩小
  await capturePetAt(win, ball, petCenter, ctx)
  assertLive(ctx)
  stamp(`捕获完成（宠物缩至 ${BALL_ANIMATION_CONFIG.shrinkScale}×，${rectStr(win.getBounds())}）`)

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
    BALL_ANIMATION_CONFIG.returnMs,
    ctx
  )
  assertLive(ctx)
  stamp(`到达托盘锚点（return ${BALL_ANIMATION_CONFIG.returnMs}ms）`)

  // ④ 宠物 hide（此刻它已在托盘处的缩小态）；球淡出收窗
  win.hide()
  await fadeBallOut(ball, ctx)
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
  const stamp = (msg: string): void => console.log(`[ball-animation] t=${Date.now() - t0}ms ${msg}`)

  // 原位：优先用隐藏时记录的家；缺失（异常路径）时退回当前 bounds
  const home = stashedBounds ?? win.getBounds()
  const homeCenter = centerOf(home)
  stamp(`显示动画开始：原位 ${rectStr(home)}，锚点 ${ptStr(anchor)}`)

  // ① 球（载宠物剪影）沿拱线从托盘飞到原位中心（飞行期间宠物窗口保持隐藏，由球"携带"）
  await flyBallFromAnchor(ball, anchor, homeCenter, wa, true, ctx)
  assertLive(ctx)
  stamp(`球到达原位（flight ${BALL_ANIMATION_CONFIG.flightMs}ms）`)

  // ② 释放：宠物窗口以原位缩小态出现（不抢焦点）→ 爆闪 + 落地 Q 弹 + 放大归位
  await releasePetAt(win, ball, home, ctx)
  assertLive(ctx)
  stashedBounds = null
  stamp(`放大归位完成（${rectStr(win.getBounds())}）`)

  // ③ 球淡出收窗
  await fadeBallOut(ball, ctx)
  stamp('显示动画完成')
}

// ------------------------------------------------------------------ 移动流程（设置向导 §7.6.6）

/**
 * 移动动画·**远距魔法档**（relocate，"原地凝聚起手"的完整魔法流程，2026-10-16 用户定稿；
 * 仅当距离 ≥ relocateMagicMinPx 时由 runFlow 分流至此）：
 * ① 球**直接在宠物所在处凝聚显现**（spawn 指令；不走"从托盘锚点飞来"的绕路）→
 * ② 爆闪捕获（宠物原地缩至 shrinkScale + 挣扎反应）→ ③ 球拎着缩小态宠物沿拱线
 * 飞到目标位 → ④ 释放爆闪 + 宠物放大归位 → ⑤ 球淡出收窗。
 *
 * 魔法视觉与 hide/show 完全同源（同一套球窗/爆闪/星屑）；与旧实现的唯一差别 =
 * 起手不再"球从托盘飞来"。沿革：旧实现起手 = 球从托盘锚点飞来（用户指出多余）→
 * 曾误改为"宠物本体裸飞"（魔法效果全删，用户当场纠正）→ 现版 = 魔法流程原地起手
 * （近距另走 relocateGlideFlow——"离得近就别表演了"）。
 *
 * 入位（原位置 → 设置窗底沿）与回位（向导位 → 原位置）共用本流程。
 */
async function relocateMagicFlow(
  win: BrowserWindow,
  ball: BrowserWindow,
  wa: Rect,
  target: Rect,
  ctx: FlowContext
): Promise<void> {
  const t0 = Date.now()
  const stamp = (msg: string): void => console.log(`[ball-animation] t=${Date.now() - t0}ms ${msg}`)

  // 防御：宠物当前隐藏时（向导流程理论上总在可见时触发；竞态下可能赶上隐藏）——
  // 只静默 setBounds(target)（不播动画、不显示：避免"回位"把用户刚隐藏的宠物弹出，
  // 保持可见性状态不变，见 settings 域回位约定）
  if (!win.isVisible()) {
    console.log(`[ball-animation] 移动动画：宠物当前隐藏 → 仅静默改坐标至 ${rectStr(target)}（不播动画、不显示）`)
    win.setBounds(target)
    return
  }

  const from = win.getBounds()
  const petCenter = centerOf(from)
  const toCenter = centerOf(target)
  stamp(`移动动画开始（远距魔法）：宠物 ${rectStr(from)} → ${rectStr(target)}`)

  // ① 球在宠物处原地凝聚显现（球窗定位到宠物中心；动画页从无到有画出光球 + 微脉动）
  ball.setBounds(boundsAround(petCenter, BALL_ANIMATION_CONFIG.ballWindowSize, BALL_ANIMATION_CONFIG.ballWindowSize))
  sendCommand(ball, { type: 'spawn', durationMs: BALL_ANIMATION_CONFIG.relocateSpawnMs })
  await sleep(BALL_ANIMATION_CONFIG.relocateSpawnMs, ctx)
  assertLive(ctx)
  stamp(`球凝聚完成（原地 ${BALL_ANIMATION_CONFIG.relocateSpawnMs}ms）`)

  // ② 捕获爆闪：宠物原地缩小（只改几何，不 hide）
  await capturePetAt(win, ball, petCenter, ctx)
  assertLive(ctx)
  stamp(`捕获完成（宠物缩至 ${BALL_ANIMATION_CONFIG.shrinkScale}×，${rectStr(win.getBounds())}）`)

  // ③ 球拎着缩小态宠物沿拱线飞向目标位（终点 = 目标矩形中心，释放点与目标同中心）
  const petShrunk = win.getBounds()
  sendCommand(ball, { type: 'flight', cargo: true })
  await flyBothArc(
    ball,
    win,
    petCenter,
    toCenter,
    wa,
    { width: petShrunk.width, height: petShrunk.height },
    BALL_ANIMATION_CONFIG.returnMs,
    ctx
  )
  assertLive(ctx)
  stamp(`到达目标位（fly ${BALL_ANIMATION_CONFIG.returnMs}ms）`)

  // ④ 释放爆闪 + 宠物在目标位放大归位
  await releasePetAt(win, ball, target, ctx)
  assertLive(ctx)
  stamp(`放大归位完成（${rectStr(win.getBounds())}）`)

  // ⑤ 球淡出收窗
  await fadeBallOut(ball, ctx)
  stamp('移动动画完成')
}

/**
 * 移动动画·**近距档**（relocate 距离分档，2026-10-16 用户定稿；距离 < relocateMagicMinPx
 * 时由 runFlow 分流至此）：宠物原样沿小弧**平滑滑过去**——无球无爆闪（"离设置很近就别
 * 表演整套魔法了"）；**太近**（< relocateNearStepPx）则直接落位（"太近了不用飞"）。
 *
 * 与魔法档共用同一条贝塞尔拱线（makeArcPath），仅时长与视觉分量不同；不依赖球窗/动画页
 * （纯窗口移动）。防御与魔法档一致：宠物隐藏时只静默改坐标。
 */
async function relocateGlideFlow(
  win: BrowserWindow,
  wa: Rect,
  target: Rect,
  ctx: FlowContext
): Promise<void> {
  const t0 = Date.now()
  const stamp = (msg: string): void => console.log(`[ball-animation] t=${Date.now() - t0}ms ${msg}`)

  if (!win.isVisible()) {
    console.log(`[ball-animation] 移动动画：宠物当前隐藏 → 仅静默改坐标至 ${rectStr(target)}（不播动画、不显示）`)
    win.setBounds(target)
    return
  }

  const from = win.getBounds()
  const fromCenter = centerOf(from)
  const toCenter = centerOf(target)
  const dist = Math.hypot(toCenter.x - fromCenter.x, toCenter.y - fromCenter.y)

  if (dist < BALL_ANIMATION_CONFIG.relocateNearStepPx) {
    win.setBounds(target)
    stamp(
      `移动动画：距离 ${Math.round(dist)}px < ${BALL_ANIMATION_CONFIG.relocateNearStepPx}px → 直接落位（太近了不用飞）`
    )
    return
  }

  stamp(`移动动画开始（近距平滑移位 ${Math.round(dist)}px）：宠物 ${rectStr(from)} → ${rectStr(target)}`)
  const path = makeArcPath(fromCenter, toCenter, wa)
  await animateWindowBounds(
    win,
    BALL_ANIMATION_CONFIG.relocateGlideMs,
    easeInOutCubic,
    (e) => boundsAround(path(e), from.width, from.height),
    ctx
  )
  assertLive(ctx)
  // 精确落位：曲线数值收口（防浮点累积让落点差 1~2px）
  if (!win.isDestroyed()) win.setBounds(target)
  stamp(`平滑移位完成（${rectStr(target)}）`)
}

// ------------------------------------------------------------------ 对外流程（锁 + 兜底）

/** 动画方向（对外三流程：隐藏 / 显示 / 移动） */
type FlowDirection = 'hide' | 'show' | 'relocate'

/**
 * 动画公共外壳：锁 → 就绪等待 → 流程 → 兜底（保证结果语义）。
 * @param target 仅 relocate 方向使用：异常/降级兜底时直接落到该目标矩形。
 */
async function runFlow(
  win: BrowserWindow,
  direction: FlowDirection,
  degrade: () => void,
  target?: Rect,
  forceGlide = false
): Promise<void> {
  const label = direction === 'hide' ? '隐藏' : direction === 'show' ? '显示' : '移动'
  if (win.isDestroyed()) return
  if (busy) {
    console.log(`[ball-animation] 动画进行中，忽略本次${label}请求`)
    return
  }
  busy = true
  const ctx: FlowContext = { aborted: false }
  const watchdog = setTimeout(() => {
    ctx.aborted = true
    console.warn(`[ball-animation] ${label}动画超时（>${BALL_ANIMATION_CONFIG.totalTimeoutMs}ms），看门狗中止`)
  }, BALL_ANIMATION_CONFIG.totalTimeoutMs)
  try {
    if (direction === 'relocate') {
      // 移动方向按距离分档（2026-10-16 用户定稿）：
      //   远距（≥ relocateMagicMinPx）：完整魔法，需要球窗与 动画页就绪；不定位托盘锚点
      //     （球不走"从托盘飞来"的绕路，直接在宠物处凝聚）；
      //   近距（< 上限）：平滑移位 / 太近直接落位——纯窗口移动，不建球窗、不等 动画页。
      if (!target) return
      const wa = screen.getPrimaryDisplay().workArea
      const fromC = centerOf(win.getBounds())
      const toC = centerOf(target)
      const dist = Math.hypot(toC.x - fromC.x, toC.y - fromC.y)
      if (dist < BALL_ANIMATION_CONFIG.relocateMagicMinPx || forceGlide) {
        // 近距档 / 强制滑步（教学入位）：平滑移位或直接落位——不建球窗、不等 动画页
        await relocateGlideFlow(win, wa, target, ctx)
      } else {
        const ball = ensureBallWindow()
        const ready = await waitFxReady(BALL_ANIMATION_CONFIG.readyTimeoutMs)
        if (!ready) {
          console.warn(`[ball-animation] 动画页未就绪（>${BALL_ANIMATION_CONFIG.readyTimeoutMs}ms），本次降级为直接${label}`)
          degrade()
          return
        }
        sendCommand(ball, { type: 'reset' })
        ball.moveTop() // 与宠物同为 screen-saver 层：显示前 raise 自保（球要盖在宠物上表现吸进/放出）
        ball.showInactive()
        await relocateMagicFlow(win, ball, wa, target, ctx)
      }
    } else {
      const ball = ensureBallWindow()
      // 动画页就绪等待 与 锚点解析并行 —— 降低"按下到球起飞"的感知延迟；
      // 锚点优先托盘域提供者（Windows = tray.getBounds / 任务栏角落，零延迟）；
      // 没有提供者（Linux）才走抓屏模板匹配；任何失败都返回兜底值，绝不影响动画播放
      const [ready, anchorPoint] = await Promise.all([
        waitFxReady(BALL_ANIMATION_CONFIG.readyTimeoutMs),
        resolveTrayAnchorPoint()
      ])
      if (!ready) {
        console.warn(`[ball-animation] 动画页未就绪（>${BALL_ANIMATION_CONFIG.readyTimeoutMs}ms），本次降级为直接${label}`)
        degrade()
        return
      }
      sendCommand(ball, { type: 'reset' })
      ball.moveTop() // 与宠物同为 screen-saver 层：显示前 raise 自保（球要盖在宠物上表现吸进/放出）
      ball.showInactive()
      const wa = screen.getPrimaryDisplay().workArea
      const anchor: Point = anchorPoint
      if (direction === 'hide') await hideFlow(win, ball, wa, anchor, ctx)
      else await showFlow(win, ball, wa, anchor, ctx)
    }
  } catch (err) {
    console.error(`[ball-animation] ${label}动画异常，兜底直接${label}：`, err)
    if (!win.isDestroyed()) {
      if (direction === 'hide') {
        win.hide()
      } else if (direction === 'show') {
        // 显示方向异常兜底：一定可见 + 归位（stash 有则回原位）
        if (stashedBounds) win.setBounds(stashedBounds)
        if (!win.isVisible()) win.showInactive()
      } else if (target) {
        // 移动方向异常兜底：一定落在目标矩形（可见性保持原状——宠物若已被隐藏不强行显示）
        win.setBounds(target)
      }
    }
  } finally {
    clearTimeout(watchdog)
    if (!win.isDestroyed()) {
      // 结果语义兜底（幂等）：隐藏方向一定不可见；显示方向一定可见
      // （移动方向不改可见性：由 relocate 流程自己保证"可见进 → 可见出"）
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
  if (!BALL_ANIMATION_CONFIG.ENABLED) {
    win.hide()
    return Promise.resolve()
  }
  return runFlow(win, 'hide', () => win.hide())
}

/** 显示流程：托盘菜单"显示宠物"、托盘单击等路径统一调用 */
export function runShowAnimation(win: BrowserWindow): Promise<void> {
  if (!BALL_ANIMATION_CONFIG.ENABLED) {
    win.showInactive()
    return Promise.resolve()
  }
  return runFlow(win, 'show', () => {
    // 降级：瞬时显示（并发进行归位——stash 存在时窗口当前在缩小态）
    if (stashedBounds && !win.isDestroyed()) win.setBounds(stashedBounds)
    win.showInactive()
  })
}

/** 等待动画锁空闲（relocate 专用；100ms 粒度轮询，超时返回 false） */
function waitBusyFree(timeoutMs: number): Promise<boolean> {
  if (!busy) return Promise.resolve(true)
  const t0 = Date.now()
  return new Promise((resolve) => {
    const tick = (): void => {
      if (!busy) {
        resolve(true)
        return
      }
      if (Date.now() - t0 >= timeoutMs) {
        resolve(false)
        return
      }
      setTimeout(tick, 100)
    }
    setTimeout(tick, 100)
  })
}

/**
 * 移动流程（设置向导 §7.6.6）：把宠物从当前位挪到 target——**按距离分档**（2026-10-16 定稿）：
 *   ≥ relocateMagicMinPx：完整魔法（球**在宠物处原地凝聚** → 捕获爆闪 → 携宠沿拱线飞行
 *     → 释放爆闪；见 relocateMagicFlow；不经托盘锚点——"不用经过托盘图标飞出"）；
 *   < 上限：近距平滑移位 / 太近直接落位（见 relocateGlideFlow）。
 *
 * 与隐藏/显示不同：relocate 是向导编排（入位/回位）的关键一步，不采用"忙则忽略"——
 * 在途动画优先收尾（上限 BALL_ANIMATION_CONFIG.relocateBusyWaitMs），超时才放弃本次（日志警告；
 * 调用方按"未移动"处理，见 settings 域的向导状态机）。
 * 结果语义：宠物窗口在 target；可见性保持调用前状态（可见进可见出；隐藏态只搬家不弹出）。
 *
 * @param target 目标矩形（屏幕坐标，含尺寸——异常兜底按此一步到位）
 * @param opts.forceGlide 强制走"近距平滑移位"档（跳过魔法/球窗流程）——教学入位专用：
 *   兔子"滑步就位"（去讲课，不搞"被魔法球捕获"）；同时天然**不受 moveTo 的工作区夹取**
 *   限制（allowOverflow 语义——讲台位窗底允许超出工作区下沿）。
 */
export async function runRelocateAnimation(
  win: BrowserWindow,
  target: Rect,
  opts?: { forceGlide?: boolean }
): Promise<void> {
  if (!win || win.isDestroyed()) return
  if (!BALL_ANIMATION_CONFIG.ENABLED) {
    win.setBounds(target)
    return
  }
  const free = await waitBusyFree(BALL_ANIMATION_CONFIG.relocateBusyWaitMs)
  if (!free) {
    console.warn(
      `[ball-animation] 在途动画超过 ${BALL_ANIMATION_CONFIG.relocateBusyWaitMs}ms 未收尾，放弃本次移动（目标 ${rectStr(target)}）`
    )
    return
  }
  if (win.isDestroyed()) return
  // 隐藏态早退（在锁空闲之后判断：此刻无在途动画、窗口静止）——只搬家不显示、不播动画，
  // 也避免白闪一个空球窗；"就绪等待期间被隐藏"的竞态由 relocate 流程内防御分支兜底
  if (!win.isVisible()) {
    console.log(`[ball-animation] 移动动画：宠物当前隐藏 → 仅静默改坐标至 ${rectStr(target)}（不播动画、不显示）`)
    win.setBounds(target)
    return
  }
  return runFlow(
    win,
    'relocate',
    () => {
      // 降级：瞬时落位（动画页未就绪/超时——不播动画，位置语义照旧）
      win.setBounds(target)
    },
    target,
    opts?.forceGlide
  )
}
