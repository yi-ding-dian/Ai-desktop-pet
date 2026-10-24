/** 气泡窗本身：懒创建、就绪握手、窗口形状、隐藏复用/销毁重建。 */
import { app, BrowserWindow, type WebContents } from 'electron'
import { join } from 'node:path'
import { linuxOnlyWindowOptions, REUSE_BUBBLE_WINDOW } from '../platform'
import { IPC_BUBBLE } from '../ipc/channels'
import { ESTIMATED_SIZE, OPEN_REPOST_MS } from './constants'
import { bubbleState } from './state'
import type { Point, Rect } from '../window'

const isDev = !app.isPackaged

/** 气泡窗（懒创建；隐藏收尾即销毁——每次弹出重建，缘由见 destroyBubbleWindow） */
let bubbleWin: BrowserWindow | null = null
/** 气泡页已就绪标志（收到 READY 置位；窗口重建后复位） */
let bubbleReady = false
/** 等待就绪的回调队列（气泡页就绪时统一唤醒） */
let readyWaiters: Array<() => void> = []
/**
 * 气泡窗创建序号（每次 createBubbleWindow 递增；作 partition 后缀——见 createBubbleWindow 的
 * "为何每次新 partition"说明。进程级状态（渲染进程复用坏状态）是 v1"销毁重建"失效的根因）。
 */
let windowSeq = 0
/** 气泡窗交互形状（渲染侧 REPORT_SHAPE 上报；win.setShape 裁输入区，其余穿透） */
let shapeRects: Rect[] = []
/** Windows 复用策略的预热定时器（will-quit 清理，避免退出过程中又建窗） */
let warmTimer: NodeJS.Timeout | null = null
/** 失焦收起动作（index 注入 closeBubble；避免 window ↔ lifecycle 循环依赖） */
let blurHandler: () => void = () => {}

export function setBlurHandler(handler: () => void): void {
  blurHandler = handler
}

// ------------------------------------------------------------------ 查询

/** 向气泡窗发送（窗口缺失/销毁时静默忽略） */
export function sendTo(win: BrowserWindow | null, channel: string, payload?: unknown): void {
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return
  try {
    win.webContents.send(channel, payload)
  } catch (err) {
    console.warn(`[bubble] 发送 ${channel} 失败（忽略）：`, err)
  }
}

/** sender 是否宠物窗口（REQUEST_OPEN 只认它——本期唯一合法入口） */
export function isPetSender(sender: WebContents): boolean {
  const pet = bubbleState.petWin
  return Boolean(pet && !pet.isDestroyed() && sender.id === pet.webContents.id)
}

/** sender 是否当前受管气泡窗（"气泡面专属"消息只认它） */
export function isBubbleSender(sender: WebContents): boolean {
  return Boolean(bubbleWin && !bubbleWin.isDestroyed() && sender.id === bubbleWin.webContents.id)
}

export function getBubbleWindow(): BrowserWindow | null {
  return bubbleWin
}

/** 当前窗是否在显示菜单/确认内容（交互态） */
export function isMenuShowing(): boolean {
  return Boolean(
    bubbleWin &&
      !bubbleWin.isDestroyed() &&
      bubbleWin.isVisible() &&
      !bubbleState.closing &&
      bubbleState.currentPayload?.variant !== 'text'
  )
}

/** 当前窗是否在显示说话气泡（纯展示态） */
export function isSpeechShowing(): boolean {
  return Boolean(
    bubbleWin &&
      !bubbleWin.isDestroyed() &&
      bubbleWin.isVisible() &&
      !bubbleState.closing &&
      bubbleState.currentPayload?.variant === 'text'
  )
}

/** 点是否在当前说话气泡窗内（右键落到宠物窗时的兜底判定） */
export function pointInsideBubble(point: Point): boolean {
  const win = bubbleWin
  if (!win || win.isDestroyed() || !win.isVisible()) return false
  const b = win.getBounds()
  return (
    point.x >= b.x &&
    point.x < b.x + b.width &&
    point.y >= b.y &&
    point.y < b.y + b.height
  )
}

// ------------------------------------------------------------------ 就绪握手

/** 气泡页 READY：唤醒等待队列 */
export function markBubbleReady(): void {
  bubbleReady = true
  const waiters = readyWaiters
  readyWaiters = []
  waiters.forEach((fn) => fn())
}

/** 等待气泡页就绪（带超时） */
export function waitBubbleReady(timeoutMs: number): Promise<boolean> {
  if (bubbleReady) return Promise.resolve(true)
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

// ------------------------------------------------------------------ 形状 / 重绘

/**
 * 应用渲染侧上报的交互形状（setShape：输入区 = 上报矩形，形状外完全穿透）。
 * Windows 同样走这条（setShape 官方平台标注 win32+linux）。
 */
export function applyBubbleShape(): void {
  const win = bubbleWin
  if (!win || win.isDestroyed() || shapeRects.length === 0) return
  try {
    win.setShape(shapeRects)
  } catch (err) {
    console.warn('[bubble] setShape 失败（忽略）：', err)
  }
}

export function setShapeRects(rects: Rect[]): void {
  shapeRects = rects
  applyBubbleShape()
}

/**
 * 强制气泡窗渲染进程全量重绘（轻量兜底，非根治；根治 = 每次弹出重建窗口）。
 */
export function forceRepaint(win: BrowserWindow): void {
  if (win.isDestroyed() || win.webContents.isDestroyed()) return
  try {
    win.webContents.invalidate()
  } catch (err) {
    console.warn('[bubble] 强制重绘失败（忽略）：', err)
  }
}

/**
 * show 后延迟补发当前内容：did-finish-load 早于 React 订阅建立时首帧可能丢失的兜底。
 * 幂等安全：同 session 载荷渲染侧只认不重播。
 */
export function scheduleOpenRepost(win: BrowserWindow): void {
  setTimeout(() => {
    if (
      bubbleWin === win &&
      win.isVisible() &&
      !bubbleState.closing &&
      bubbleState.currentPayload
    ) {
      sendTo(win, IPC_BUBBLE.OPEN, bubbleState.currentPayload)
    }
  }, OPEN_REPOST_MS)
}

// ------------------------------------------------------------------ 窗口生命周期

/** 加载气泡页：dev 走渲染服务器，生产走打包产物 */
function loadBubblePage(win: BrowserWindow): void {
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (isDev && devUrl) {
    try {
      void win.loadURL(new URL('bubble.html', devUrl).toString())
      return
    } catch (err) {
      console.warn(`[bubble] ELECTRON_RENDERER_URL 非法（${devUrl}），回退 loadFile：`, err)
    }
  }
  void win.loadFile(join(__dirname, '../renderer/bubble.html'))
}

/** 创建气泡窗（窗口技术照 ball-animation 球窗/自绘托盘菜单先例） */
function createBubbleWindow(): BrowserWindow {
  const est = ESTIMATED_SIZE.menu
  const win = new BrowserWindow({
    width: est.width,
    height: est.height,
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
    // DDE(Dock) 忽略 skipTaskbar——沿用宠物窗实测结论：type:'toolbar' 可让 Dock 不出现窗口格
    ...linuxOnlyWindowOptions(),
    show: false,
    webPreferences: {
      /**
       * **每次唯一 partition（`bubble-序号`；Linux/macOS）** —— 强制"独立 storage session"
       * ⇒ Chromium 必然分配全新渲染进程；坏状态存在于渲染进程内部（合成器/surface 缓存），
       * 只有全新进程才能根治 KWin 残屏。Windows 隐藏复用，partition 固定为 `bubble`。
       */
      partition: REUSE_BUBBLE_WINDOW ? 'bubble' : `bubble-${++windowSeq}`,
      preload: join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  // 层级抬到最高（同球窗/菜单窗）：气泡出现时应盖在宠物窗/设置窗之上
  win.setAlwaysOnTop(true, 'screen-saver')

  if (isDev) {
    win.webContents.on('console-message', (_event, _level, message) => {
      console.log(`[bubble-renderer] ${message}`)
    })
  }

  // 失焦自动收起（标准弹窗行为）。仅交互态注册——纯展示态不聚焦也无 blur
  win.on('blur', () => {
    if (bubbleState.speechContextMenuOpen || !bubbleState.interactive) return
    if (!win.isDestroyed() && win.isVisible()) blurHandler()
  })

  win.on('closed', () => {
    if (bubbleWin === win) {
      bubbleWin = null
      bubbleReady = false
    }
  })

  // 加载失败/渲染崩溃兜底：销毁窗口清引用（下次弹出重建重试）
  win.webContents.on(
    'did-fail-load',
    (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrame || bubbleWin !== win) return
      console.error(
        `[bubble] 气泡页加载失败（${errorCode} ${errorDescription} ${validatedURL}），销毁窗口以便重试`
      )
      bubbleWin = null
      bubbleReady = false
      if (!win.isDestroyed()) win.destroy()
    }
  )
  win.webContents.on('render-process-gone', (_event, details) => {
    if (bubbleWin !== win) return
    console.error(`[bubble] 气泡页渲染进程崩溃（${details.reason}），销毁窗口以便重试`)
    bubbleWin = null
    bubbleReady = false
    if (!win.isDestroyed()) win.destroy()
  })

  loadBubblePage(win)
  console.log(`[bubble] 气泡窗已创建（预估 ${est.width}x${est.height}）`)
  return win
}

/** 取（必要时创建）气泡窗——隐藏收尾已销毁，正常路径基本总是新建 */
export function ensureBubbleWindow(): BrowserWindow {
  if (bubbleWin && !bubbleWin.isDestroyed()) return bubbleWin
  bubbleReady = false
  bubbleWin = createBubbleWindow()
  return bubbleWin
}

/**
 * 收尾当前气泡窗（隐藏收尾时调用）：
 * - Windows：只 hide、保留窗口与渲染进程；
 * - Linux/macOS：销毁，下次重建（每次唯一 partition 配套）。
 */
export function destroyBubbleWindow(reason: string): void {
  shapeRects = []
  const win = bubbleWin
  if (!win || win.isDestroyed()) {
    bubbleWin = null
    bubbleReady = false
    return
  }
  if (REUSE_BUBBLE_WINDOW) {
    if (win.isVisible()) win.hide()
    try {
      const b = win.getBounds()
      win.setShape([{ x: 0, y: 0, width: b.width, height: b.height }])
    } catch (err) {
      console.warn('[bubble] 隐藏复用前重置窗口形状失败（忽略）：', err)
    }
    console.log(`[bubble] 气泡窗已隐藏复用（${reason}）`)
    return
  }

  bubbleWin = null
  bubbleReady = false
  win.destroy()
  console.log(`[bubble] 气泡窗已销毁（${reason}）——下次弹出重建`)
}

/** 应用退出：取消预热并销毁窗口 */
export function destroyBubbleWindowFully(): void {
  if (warmTimer) {
    clearTimeout(warmTimer)
    warmTimer = null
  }
  const win = bubbleWin
  bubbleWin = null
  bubbleReady = false
  readyWaiters = []
  shapeRects = []
  if (win && !win.isDestroyed()) win.destroy()
}

/** Windows 复用策略：延迟预热气泡窗 */
export function warmBubbleWindow(): void {
  if (!REUSE_BUBBLE_WINDOW) return
  warmTimer = setTimeout(() => {
    warmTimer = null
    if (!bubbleWin) {
      console.log('[bubble] 预热气泡窗（Windows 复用策略）')
      ensureBubbleWindow()
    }
  }, 1500)
}

