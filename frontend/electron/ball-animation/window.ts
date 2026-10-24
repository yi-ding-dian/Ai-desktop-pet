/**
 * 球窗（fx）：懒创建、就绪握手、指令下发与销毁。
 *
 * 窗口技术照宠物窗 linux.ts 先例：transparent + frame:false + alwaysOnTop(screen-saver)
 * + skipTaskbar + type:'toolbar' + focusable:false + 全点击穿透。
 */
import { app, BrowserWindow, ipcMain } from 'electron'
import { join } from 'node:path'
import {
  IPC_EVENTS,
  IPC_BALL_ANIMATION,
  type BallAnimationCommand,
  type BallAnimationPetReactionPayload,
  type PetSayLinePayload
} from '../ipc/channels'
import { BALL_ANIMATION_CONFIG } from './config'
import { locateTrayAnchor } from './anchor'
import type { Point } from '../window'

const isDev = !app.isPackaged

// ------------------------------------------------------------------ 状态

/** 球窗（懒创建；首次隐藏/显示时建立，之后复用——hide 而非 destroy，下次秒开） */
let ballWin: BrowserWindow | null = null
/** 动画页已就绪标志（收到 ball-animation:ready 后置位；窗口重建后复位） */
let fxReady = false
/** 等待就绪的回调队列（动画页加载完成时统一唤醒） */
let readyWaiters: Array<() => void> = []
/** ipcMain 就绪监听是否已注册（只注册一次） */
let readyListenerInstalled = false

/**
 * 托盘锚点提供者（托盘域注册）：Windows 用 `tray.getBounds()`（零延迟）或任务栏角落兜底；
 * 返回 null = 走 `locateTrayAnchor()` 抓屏模板匹配（Linux 的既有路径）。
 */
type TrayAnchorProvider = () => Point | null
let trayAnchorProvider: TrayAnchorProvider | null = null

/** 注册托盘锚点提供者（托盘创建时调用；传 null 撤销） */
export function setTrayAnchorProvider(provider: TrayAnchorProvider | null): void {
  trayAnchorProvider = provider
}

/** 解析动画锚点：优先托盘域提供者；未注册/返回 null 时退回抓屏模板匹配 */
export async function resolveTrayAnchorPoint(): Promise<Point> {
  const provided = trayAnchorProvider?.()
  if (provided) return provided
  const res = await locateTrayAnchor()
  return { x: res.x, y: res.y }
}

// ------------------------------------------------------------------ 就绪握手

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
export function waitFxReady(timeoutMs: number): Promise<boolean> {
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

// ------------------------------------------------------------------ 窗口

/**
 * 创建球窗（懒创建）。
 * 多屏适配：球窗"飞到哪就把自己挪到哪"，屏幕选择天然落在目标坐标所在屏。
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
export function ensureBallWindow(): BrowserWindow {
  installReadyListener()
  if (ballWin && !ballWin.isDestroyed()) return ballWin
  ballWin = createBallWindow()
  return ballWin
}

/** 当前球窗（供流程外壳收窗；未创建时为 null） */
export function currentBallWindow(): BrowserWindow | null {
  return ballWin
}

// ------------------------------------------------------------------ 指令

/** 下发动画指令（窗口/页面异常时静默忽略） */
export function sendCommand(win: BrowserWindow, cmd: BallAnimationCommand): void {
  if (win.isDestroyed() || win.webContents.isDestroyed()) return
  win.webContents.send(IPC_BALL_ANIMATION.COMMAND, cmd)
}

/** 通知宠物窗口渲染侧播放"被抓/被放"反应（隐藏窗口也能收到，渲染进程仍存活） */
export function sendPetReaction(
  win: BrowserWindow,
  kind: BallAnimationPetReactionPayload['kind']
): void {
  if (win.isDestroyed() || win.webContents.isDestroyed()) return
  const payload: BallAnimationPetReactionPayload = { kind }
  win.webContents.send(IPC_EVENTS.PET_FX_REACTION, payload)
}

/**
 * 让宠物说一句生命周期台词（启动问候 / 退出告别）：渲染侧经说话气泡展示。
 * 台词固定本地文案——不经过后端，启动/退出时序完全可预期。
 */
export function sendPetSay(win: BrowserWindow, payload: PetSayLinePayload): void {
  if (win.isDestroyed() || win.webContents.isDestroyed()) return
  win.webContents.send(IPC_EVENTS.PET_SAY_LINE, payload)
}

// ------------------------------------------------------------------ 生命周期

/**
 * 预热球窗与动画页（app.whenReady 时调用，与宠物窗创建并行）：
 * 首次冷启动的入场演出不必再等动画页加载，缩短短暂的黑屏窗口。幂等。
 */
export function prewarmBallAnimation(): void {
  if (!BALL_ANIMATION_CONFIG.ENABLED) return
  try {
    ensureBallWindow()
  } catch (err) {
    // 预热失败绝不能影响启动：入场演出会按"动画页未就绪"降级为直接显示
    console.warn('[ball-animation] 预热球窗失败（启动演出将降级为直接显示）：', err)
  }
}

/** 应用退出时销毁球窗（走 will-quit；正常退出路径不播动画、也不等待动画） */
export function destroyBallAnimation(): void {
  if (ballWin && !ballWin.isDestroyed()) ballWin.destroy()
  ballWin = null
  fxReady = false
  readyWaiters = []
}
