/**
 * 工作模式域（2026-10-18）——独立聊天窗的生命周期 + 跨窗口中继。
 *
 * 职责边界：
 *  - 窗口：单例、无边框自绘（attachFrameless 提供拖动/四边缩放）、默认右侧居中；
 *    关闭 = 隐藏（保留记录与滚动位置），应用退出时才真正销毁；
 *  - 数据：宠物窗是唯一 WS 连接方。工作窗的发送/打断/历史请求经本域转发给宠物窗，
 *    宠物窗的对话镜像经本域转发回工作窗；
 *  - 可靠性：工作窗 `ready` 前缓冲事件（上限 500）；发送与历史请求用 requestId
 *    配对，8 秒超时；宠物窗重载/崩溃时拒绝所有在途请求并通知工作窗重新同步。
 *
 * 刻意不做：工作窗不连 WS、不管理会话、不改教学模式状态。
 */
import { app, BrowserWindow, ipcMain, screen, shell, type WebContents } from 'electron'
import { join } from 'node:path'
import {
  IPC_AGENT,
  IPC_WORK,
  type WorkHistoryPayload,
  type WorkHistoryRequestPayload,
  type WorkMirrorEvent,
  type WorkSendRequestPayload,
  type WorkSendResultPayload
} from '../ipc/channels'
import { resolveAppIconImage } from '../app-icon'
import type { Rect } from '../window'
import { attachFrameless, applyFramelessBounds, framelessBounds } from '../window/frameless'
import { getTeachingMode } from '../teaching'
import { linuxOnlyWindowOptions } from '../platform'
import { WorkBrowser } from './browser'
import {
  WORK_EDGE_MARGIN,
  WORK_FOLD_DURATION_MS,
  WORK_MIN_HEIGHT,
  WORK_MIN_WIDTH,
  animateWorkBounds,
  clampWorkRect,
  defaultWorkRect,
  foldedWorkBounds
} from './geometry'
import { normalizeHistoryPayload, normalizeSendPayload } from './payload'
import { PetDock } from './pet-dock'

const isDev = !app.isPackaged

/** 发送/历史请求的等待上限（ms）：宠物窗崩溃/重载时不让 invoke 永久挂起 */
const REQUEST_TIMEOUT_MS = 8_000

/** 工作窗 ready 前的事件缓冲上限（条）；超出丢最旧 */
const EVENT_BUFFER_LIMIT = 500

const WORK_WINDOW_TITLE = '工作模式 · AI 桌面宠物'

// ------------------------------------------------------------------ 模块级状态（本域单例）

let workWin: BrowserWindow | null = null
/** 工作窗内嵌浏览器（每个窗口实例一个；窗口销毁时同步销毁所有标签页） */
let workBrowser: WorkBrowser | null = null
let petWin: BrowserWindow | null = null
/** 工作窗渲染侧是否已安装订阅（收到 `work:ready`）；此前事件进缓冲 */
let workReady = false
/** 工作窗形态记忆（本次运行内沿用，与黑板一致） */
let workRectOverride: Rect | null = null
/**
 * 折叠态（最小化 = 屏幕右缘中间的小角标，2026-10-20）：
 * 折叠期间窗口仍在、对话镜像照常，点角标恢复。展开矩形记在 foldedRect。
 */
let folded = false
let foldedRect: Rect | null = null
/** 最大化前的矩形（null = 未最大化；2026-10-23） */
let maximizedFrom: Rect | null = null
/** 最大化前宠物所在矩形（还原时放回去；2026-10-23） */
let petMaximizeRestore: Rect | null = null
/** 退出流程（before-quit 置位）：不再拦截 close，避免最后一个窗口关不掉 */
let quitting = false
let ipcRegistered = false

/** 宠物落位（依附/回位/跟随），状态封装在同目录 pet-dock.ts */
const petDock = new PetDock(() => petWin, getTeachingMode)

/** ready 前缓冲的镜像事件 */
let eventBuffer: WorkMirrorEvent[] = []

interface PendingSend {
  resolve: (result: WorkSendResultPayload) => void
  timer: NodeJS.Timeout
}

interface PendingHistory {
  resolve: (result: WorkHistoryPayload) => void
  timer: NodeJS.Timeout
}

const pendingSends = new Map<string, PendingSend>()
const pendingHistory = new Map<string, PendingHistory>()

// ------------------------------------------------------------------ 小工具

function petAlive(): boolean {
  return petWin !== null && !petWin.isDestroyed()
}

function isWorkSender(sender: WebContents): boolean {
  return workWin !== null && !workWin.isDestroyed() && sender.id === workWin.webContents.id
}

function isPetSender(sender: WebContents): boolean {
  const win = petWin
  if (win === null || win.isDestroyed()) return false
  return sender.id === win.webContents.id
}

function sendToPet(channel: string, payload?: unknown): void {
  const win = petWin
  if (win === null || win.isDestroyed()) return
  if (payload === undefined) win.webContents.send(channel)
  else win.webContents.send(channel, payload)
}

function sendToWork(channel: string, payload?: unknown): void {
  if (workWin === null || workWin.isDestroyed()) return
  if (payload === undefined) workWin.webContents.send(channel)
  else workWin.webContents.send(channel, payload)
}

/**
 * 其他域 → 工作窗的单向推送（2026-10-23，任务模式状态用）。
 *
 * 工作窗未打开/已销毁时静默丢弃——任务状态以内置 service 为真相源，
 * 面板挂载时用 agent:get-state 补拉，不依赖事件不丢。
 */
export function pushToWorkWindow(channel: string, payload?: unknown): void {
  sendToWork(channel, payload)
}

/** 通知点击后切到指定任务；工作窗未就绪时先缓存，ready 后补发。 */
let pendingFocusTaskId: string | null = null
export function focusTaskInWorkWindow(id: string): void {
  pendingFocusTaskId = id
  openWork()
  if (workReady) {
    sendToWork(IPC_AGENT.FOCUS_TASK, id)
    pendingFocusTaskId = null
  }
}

/** 工作窗是否正在使用（可见、未最小化、未折叠）——宠物依附/自主行为抑制的依据；边缘动作也据此禁用 */
/** 工作窗是否处于最大化（此时宠物按桌面宠物规则贴边，不再固定依附窗口；2026-10-24） */
export function workWindowMaximized(): boolean {
  return maximizedFrom !== null
}

export function workWindowActive(): boolean {
  const win = workWin
  return (
    win !== null && !win.isDestroyed() && win.isVisible() && !win.isMinimized() && !folded
  )
}

/**
 * 广播工作窗状态：
 * - ``open`` = 窗口存在（隐藏期间仍为 true，对话镜像继续）；
 * - ``active`` = 可见且未最小化（宠物依附在工作窗左侧、自主行为暂停）。
 */
function notifyPresence(open: boolean): void {
  sendToPet(IPC_WORK.PRESENCE, { open, active: open && workWindowActive() })
}

/** 拒绝所有在途请求（宠物窗/工作窗不可用时调用） */
function rejectAll(reason: string): void {
  for (const [requestId, pending] of pendingSends) {
    clearTimeout(pending.timer)
    pending.resolve({ requestId, ok: false, reason })
    pendingSends.delete(requestId)
  }
  for (const [requestId, pending] of pendingHistory) {
    clearTimeout(pending.timer)
    pending.resolve({
      requestId,
      ok: false,
      reason,
      messages: [],
      bufferedEvents: []
    })
    pendingHistory.delete(requestId)
  }
}

// ------------------------------------------------------------------ 折叠（最小化 = 右缘角标）

/**
 * 最小化 = 折叠到屏幕右缘中间的小角标（用户需求：像板书那样，不要桌面/任务栏图标）。
 * 语义与最小化一致：宠物滑步回原位、工作窗退出活跃态（宠物恢复输入框与自主行为）；
 * 窗口不 minimize，而是缓动成 24×140 角标：折叠期间置顶（工作窗常态 skipTaskbar，
 * 本来就没有任务栏图标），点角标恢复。
 */
function foldWork(): void {
  const win = workWin
  if (win === null || win.isDestroyed() || folded) return
  folded = true
  foldedRect = framelessBounds(win)
  console.log(`[work] 最小化 → 折叠为屏幕右缘角标（展开矩形 ${foldedRect.x},${foldedRect.y}）`)
  workBrowser?.setFolded(true)
  sendToWork(IPC_WORK.FOLDED, true)
  petDock.returnHome()
  notifyPresence(true) // open=true；active=false（折叠不算活跃，宠物面恢复常态）
  win.setAlwaysOnTop(true)
  const wa = screen.getDisplayMatching(foldedRect).workArea
  void animateWorkBounds(win, foldedWorkBounds(wa), WORK_FOLD_DURATION_MS, () => workWin === win)
}

/** 展开：角标 → 折叠前的窗口矩形；宠物重新依附到工作窗左侧 */
function unfoldWork(): void {
  const win = workWin
  if (win === null || win.isDestroyed() || !folded) return
  folded = false
  const target = foldedRect ?? workRectOverride ?? defaultWorkRect(petWin)
  foldedRect = null
  console.log('[work] 点击折叠角标 → 展开工作窗')
  workBrowser?.setFolded(false)
  sendToWork(IPC_WORK.FOLDED, false)
  win.setAlwaysOnTop(false)
  win.focus()
  const wa = screen.getDisplayMatching(target).workArea
  void animateWorkBounds(win, clampWorkRect(target, wa), WORK_FOLD_DURATION_MS, () => workWin === win).then(() => {
    if (workWin !== win || win.isDestroyed()) return
    notifyPresence(true)
    petDock.place(framelessBounds(win))
  })
}

/**
 * 清掉折叠态（隐藏/销毁/退出）：不播动画，直接复位窗口属性与渲染态。
 * 隐藏时先把窗口矩形还原成展开矩形——否则下次 show 会以 24×140 的小条出现。
 */
function resetFoldedState(win: BrowserWindow, restoreBounds: boolean): void {
  if (!folded) return
  folded = false
  const rect = foldedRect
  foldedRect = null
  workBrowser?.setFolded(false)
  sendToWork(IPC_WORK.FOLDED, false)
  if (win.isDestroyed()) return
  win.setAlwaysOnTop(false)
  if (restoreBounds && rect !== null) {
    const wa = screen.getDisplayMatching(rect).workArea
    applyFramelessBounds(win, clampWorkRect(rect, wa))
  }
}

// ------------------------------------------------------------------ 窗口生命周期

function createWorkWindow(): BrowserWindow {
  const initial = workRectOverride ?? defaultWorkRect(petWin)
  const win = new BrowserWindow({
    // 任务栏图标：与托盘、通知共用兔子图标（2026-10-21）
    icon: resolveAppIconImage(),
    x: initial.x,
    y: initial.y,
    width: initial.width,
    height: initial.height,
    title: WORK_WINDOW_TITLE,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: true,
    show: false,
    minimizable: true,
    maximizable: false,
    resizable: false,
    movable: false,
    alwaysOnTop: false,
    // 2026-10-24 用户改口：工作窗需要在任务栏有图标（最大化后能从任务栏找回）。
    // 此前的"不进任务栏"定稿作废。
    skipTaskbar: false,
    ...linuxOnlyWindowOptions(),
    webPreferences: {
      preload: join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // 隐藏/被遮挡时仍要继续接收镜像并刷新（不能用默认节流）
      backgroundThrottling: false
    }
  })
  workWin = win
  workReady = false
  eventBuffer = []
  workBrowser?.destroy()
  workBrowser = new WorkBrowser(win)

  // 标题权威在主进程（同设置窗）：渲染页 <title> 不覆盖契约文案
  win.on('page-title-updated', (event) => event.preventDefault())
  win.setMenu(null)

  // 外链走系统浏览器；其余新窗口拒绝
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://') || url.startsWith('http://')) void shell.openExternal(url)
    return { action: 'deny' }
  })
  // 正文 Markdown 里的链接默认是同一窗口跳转——拦下来交给系统浏览器，防止聊天窗被导航走
  win.webContents.on('will-navigate', (event, url) => {
    if (url === win.webContents.getURL()) return
    event.preventDefault()
    if (url.startsWith('https://') || url.startsWith('http://')) void shell.openExternal(url)
  })

  if (isDev) {
    win.webContents.on('console-message', (_event, _level, message) => {
      console.log(`[work-renderer] ${message}`)
    })
  }

  // 无边框引擎：拖动标题栏 + 四边/四角缩放；形态记忆只由用户手势更新
  attachFrameless(win, {
    initialBounds: initial,
    minWidth: WORK_MIN_WIDTH,
    minHeight: WORK_MIN_HEIGHT,
    edgeMargin: WORK_EDGE_MARGIN,
    onBoundsChanged: (rect) => {
      workRectOverride = rect
      // 用户在最大化状态下拖动/缩放：视为退出最大化，复原目标随之失效
      if (maximizedFrom) {
        maximizedFrom = null
        sendMaximizedState()
      }
      // 用户拖动/缩放工作窗：宠物同帧跟到新的左缘
      petDock.follow(rect)
    }
  })

  // 显示 = 宠物依附到左侧；隐藏/最小化 = 滑步回原位（退出流程除外）
  win.on('show', () => {
    if (workWin !== win || quitting) return
    notifyPresence(true)
    petDock.place(framelessBounds(win))
  })
  win.on('hide', () => {
    if (workWin !== win || quitting) return
    // 折叠态被隐藏（托盘/外部调用）：先复位折叠并还原展开矩形，下次打开才是正常窗口
    resetFoldedState(win, true)
    notifyPresence(true)
    petDock.returnHome()
  })
  win.on('minimize', () => {
    if (workWin !== win || quitting) return
    notifyPresence(true)
    petDock.returnHome()
  })
  win.on('restore', () => {
    if (workWin !== win || quitting) return
    notifyPresence(true)
    petDock.place(framelessBounds(win))
  })

  // 关闭 = 隐藏（保留聊天记录）；退出流程（before-quit）放行
  win.on('close', (event) => {
    if (quitting) return
    event.preventDefault()
    win.hide()
  })

  win.on('closed', () => {
    const tracked = workWin === win
    if (!tracked) return
    resetFoldedState(win, false)
    workWin = null
    workReady = false
    eventBuffer = []
    workBrowser?.destroy()
    workBrowser = null
    rejectAll('work-window-closed')
    notifyPresence(false)
    if (!quitting) petDock.returnHome()
  })

  win.on('ready-to-show', () => {
    win.show()
  })

  const fail = (reason: string): void => {
    if (workWin !== win) return
    console.warn(`[work] 工作窗异常（${reason}）→ 销毁，下次打开重建`)
    workWin = null
    workReady = false
    eventBuffer = []
    workBrowser?.destroy()
    workBrowser = null
    rejectAll('work-window-failed')
    notifyPresence(false)
    if (!quitting) petDock.returnHome()
    if (!win.isDestroyed()) win.destroy()
  }
  win.webContents.on('did-fail-load', (_event, code, desc, url, isMainFrame) => {
    if (!isMainFrame) return
    fail(`did-fail-load ${code} ${desc} ${url}`)
  })
  win.webContents.on('render-process-gone', (_event, details) => {
    fail(`render-process-gone ${details.reason}`)
  })

  loadWorkPage(win)
  console.log(`[work] 工作窗已创建（${initial.width}x${initial.height} @ ${initial.x},${initial.y}）`)
  return win
}

/** dev 走渲染服务器（同目录 work.html），生产走打包产物 */
function loadWorkPage(win: BrowserWindow): void {
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (isDev && devUrl) {
    try {
      void win.loadURL(new URL('work.html', devUrl).toString())
      return
    } catch (err) {
      console.warn(`[work] ELECTRON_RENDERER_URL 非法（${devUrl}），回退 loadFile：`, err)
    }
  }
  void win.loadFile(join(__dirname, '../renderer/work.html'))
}

/** 打开工作窗（单例：已存在则还原 + 聚焦；折叠态则先展开回原窗口） */
export function openWork(): void {
  const existing = workWin
  if (existing !== null && !existing.isDestroyed()) {
    if (folded) {
      console.log('[work] 折叠态下请求打开 → 展开回原窗口')
      unfoldWork()
      return
    }
    // 本来就在显示：show() 不会再触发依附，需要手动补（用户可能已把宠物拖走）
    const alreadyVisible = existing.isVisible() && !existing.isMinimized()
    if (existing.isMinimized()) existing.restore()
    existing.show()
    existing.focus()
    notifyPresence(true)
    if (alreadyVisible) petDock.place(framelessBounds(existing))
    return
  }
  createWorkWindow()
  notifyPresence(true)
}

/** 应用退出清理（will-quit） */
/** 最大化 ⇄ 复原：填充当前显示器工作区，复原回到保存的矩形（无边框自绘，不用系统最大化） */
function sendMaximizedState(): void {
  sendToWork(IPC_WORK.MAXIMIZED, maximizedFrom !== null)
}

function toggleMaximize(): void {
  const win = workWin
  if (win === null || win.isDestroyed()) return
  if (folded) unfoldWork()
  if (maximizedFrom) {
    // 还原：窗口回原矩形，宠物也回最大化前的位置
    const rect = maximizedFrom
    maximizedFrom = null
    applyFramelessBounds(win, rect)
    const pet = petWin
    if (petMaximizeRestore) {
      if (pet && !pet.isDestroyed()) {
        pet.setBounds(petMaximizeRestore)
        if (pet.isVisible()) pet.moveTop()
      }
      petMaximizeRestore = null
    } else {
      petDock.place(rect)
    }
  } else {
    maximizedFrom = framelessBounds(win)
    const wa = screen.getDisplayMatching(win.getBounds()).workArea
    const pet = petWin
    if (pet && !pet.isDestroyed() && pet.isVisible()) {
      petMaximizeRestore = pet.getBounds()
    }
    const rect = { x: wa.x, y: wa.y, width: wa.width, height: wa.height }
    applyFramelessBounds(win, rect)
    // 最大化后宠物按“桌面宠物左缘吸附”落位（窗口贴 wa.x，渲染侧切左边缘姿态）；
    // 之后可自由拖动，拖到任意屏幕边都会吸附（最大化期间不屏蔽边缘逻辑）
    const size = petDock.size()
    petDock.placeAt({ x: wa.x, y: wa.y + Math.round((wa.height - size.height) / 2) })
    // 窗口铺满后可能盖住宠物（例如用户关过「置顶」）：显式提到最上层
    if (pet && !pet.isDestroyed() && pet.isVisible()) pet.moveTop()
  }
  sendMaximizedState()
}

export function destroyWork(): void {
  maximizedFrom = null
  petMaximizeRestore = null
  quitting = true
  const win = workWin
  workWin = null
  folded = false
  foldedRect = null
  workReady = false
  eventBuffer = []
  workBrowser?.destroy()
  workBrowser = null
  petDock.reset()
  rejectAll('app-quit')
  notifyPresence(false)
  if (win !== null && !win.isDestroyed()) win.destroy()
}

// ------------------------------------------------------------------ 入站校验

// ------------------------------------------------------------------ IPC 接线

/** 注册工作模式 IPC（main.ts 在 app ready 后调用一次） */
export function initWork(pet: BrowserWindow): void {
  petWin = pet
  if (ipcRegistered) return
  ipcRegistered = true

  // 退出流程：放行 close（否则“最后一个窗口永远隐藏 → will-quit 不触发”）
  app.once('before-quit', () => {
    quitting = true
  })

  // 宠物窗重载：重新告知工作窗存在，并让工作窗清空旧记录、重新拉历史
  pet.webContents.on('did-finish-load', () => {
    if (workWin === null || workWin.isDestroyed()) return
    notifyPresence(true)
    sendToWork(IPC_WORK.PET_READY)
  })
  // 重载开始即拒绝在途请求：宠物面的监听会先失效，晚回的结果不可信
  pet.webContents.on('did-start-loading', () => {
    rejectAll('pet-window-reloading')
  })
  pet.webContents.on('render-process-gone', () => {
    rejectAll('pet-window-gone')
  })
  pet.on('closed', () => {
    rejectAll('pet-window-closed')
  })

  // 打开：托盘/右键/关键词/渲染面共用；幂等，不做 sender 过滤
  ipcMain.on(IPC_WORK.OPEN, () => {
    openWork()
  })

  ipcMain.handle(IPC_WORK.GET_PRESENCE, () => ({
    open: workWin !== null && !workWin.isDestroyed(),
    active: workWindowActive()
  }))

  ipcMain.on(IPC_WORK.HIDE, (event) => {
    if (!isWorkSender(event.sender)) return
    workWin?.hide()
  })

  ipcMain.on(IPC_WORK.MINIMIZE, (event) => {
    if (!isWorkSender(event.sender)) return
    foldWork()
  })

  ipcMain.on(IPC_WORK.MAXIMIZE_TOGGLE, (event) => {
    if (!isWorkSender(event.sender)) return
    toggleMaximize()
  })

  ipcMain.handle(IPC_WORK.IS_MAXIMIZED, (event) => {
    if (!isWorkSender(event.sender)) return false
    return maximizedFrom !== null
  })

  ipcMain.on(IPC_WORK.UNFOLD, (event) => {
    if (!isWorkSender(event.sender)) return
    unfoldWork()
  })

  ipcMain.on(IPC_WORK.READY, (event) => {
    if (!isWorkSender(event.sender)) return
    workReady = true
    const buffered = eventBuffer
    eventBuffer = []
    for (const item of buffered) sendToWork(IPC_WORK.EVENT, item)
    // 渲染面重载后浏览器标签状态需要补发（视图仍在主进程活着）
    workBrowser?.sendState()
    // 折叠态也要补发：页面重载时角标 UI 才不会丢
    sendToWork(IPC_WORK.FOLDED, folded)
    if (pendingFocusTaskId !== null) {
      sendToWork(IPC_AGENT.FOCUS_TASK, pendingFocusTaskId)
      pendingFocusTaskId = null
    }
    console.log(`[work] 工作窗就绪，回放缓冲事件 ${buffered.length} 条`)
  })

  ipcMain.handle(IPC_WORK.REQUEST_SEND, (event, raw: unknown) => {
    const payload = normalizeSendPayload(raw)
    if (payload === null || !isWorkSender(event.sender)) {
      return { requestId: '', ok: false, reason: 'bad-request' }
    }
    if (!petAlive()) {
      return { requestId: payload.requestId, ok: false, reason: 'pet-unavailable' }
    }
    return new Promise<WorkSendResultPayload>((resolve) => {
      const timer = setTimeout(() => {
        pendingSends.delete(payload.requestId)
        resolve({ requestId: payload.requestId, ok: false, reason: 'timeout' })
      }, REQUEST_TIMEOUT_MS)
      pendingSends.set(payload.requestId, { resolve, timer })
      sendToPet(IPC_WORK.SEND_REQUEST, payload)
    })
  })

  ipcMain.on(IPC_WORK.SEND_RESULT, (event, raw: unknown) => {
    if (!isPetSender(event.sender)) return
    const payload = raw as WorkSendResultPayload
    if (payload === null || typeof payload !== 'object') return
    const pending = pendingSends.get(payload.requestId)
    if (pending === undefined) return
    clearTimeout(pending.timer)
    pendingSends.delete(payload.requestId)
    pending.resolve(payload)
  })

  ipcMain.on(IPC_WORK.INTERRUPT, (event) => {
    if (!isWorkSender(event.sender)) return
    sendToPet(IPC_WORK.INTERRUPT)
  })

  ipcMain.on(IPC_WORK.DELETE_MESSAGE, (event, raw: unknown) => {
    if (!isWorkSender(event.sender)) return
    const value = raw as { dbId?: unknown } | null
    const dbId =
      value !== null && typeof value?.dbId === 'number' ? Math.trunc(value.dbId) : NaN
    if (!Number.isFinite(dbId) || dbId <= 0) return
    sendToPet(IPC_WORK.DELETE_MESSAGE_REQUEST, { dbId })
  })

  // 内嵌浏览器：渲染面只传意图，视图生命周期/安全策略全在主进程 browser.ts
  ipcMain.on(IPC_WORK.BROWSER_OPEN, (event, raw: unknown) => {
    if (!isWorkSender(event.sender)) return
    const value = raw as { url?: unknown; label?: unknown } | null
    if (value === null || typeof value?.url !== 'string') return
    workBrowser?.open({
      url: value.url,
      label: typeof value.label === 'string' ? value.label : undefined
    })
  })

  ipcMain.on(IPC_WORK.BROWSER_CLOSE, (event, id: unknown) => {
    if (!isWorkSender(event.sender)) return
    if (typeof id !== 'string' || id.length === 0) return
    workBrowser?.close(id)
  })

  ipcMain.on(IPC_WORK.BROWSER_ACTIVATE, (event, id: unknown) => {
    if (!isWorkSender(event.sender)) return
    if (id !== null && typeof id !== 'string') return
    workBrowser?.activate(id)
  })

  ipcMain.on(IPC_WORK.BROWSER_ACTION, (event, action: unknown) => {
    if (!isWorkSender(event.sender)) return
    if (
      action !== 'back' &&
      action !== 'forward' &&
      action !== 'reload' &&
      action !== 'external'
    ) {
      return
    }
    workBrowser?.action(action)
  })

  ipcMain.on(IPC_WORK.BROWSER_OVERLAY, (event, open: unknown) => {
    if (!isWorkSender(event.sender)) return
    workBrowser?.setOverlay(Boolean(open))
  })

  ipcMain.on(IPC_WORK.REPORT_EVENT, (event, payload: WorkMirrorEvent) => {
    if (!isPetSender(event.sender)) return
    if (payload === null || typeof payload !== 'object') return
    if (workWin === null || workWin.isDestroyed()) return
    if (!workReady) {
      eventBuffer.push(payload)
      if (eventBuffer.length > EVENT_BUFFER_LIMIT) eventBuffer.shift()
      return
    }
    sendToWork(IPC_WORK.EVENT, payload)
  })

  ipcMain.handle(IPC_WORK.REQUEST_HISTORY, (event, raw: unknown) => {
    const payload = normalizeHistoryPayload(raw)
    if (payload === null || !isWorkSender(event.sender)) {
      return {
        requestId: '',
        ok: false,
        reason: 'bad-request',
        messages: [],
        bufferedEvents: []
      } satisfies WorkHistoryPayload
    }
    if (!petAlive()) {
      return {
        requestId: payload.requestId,
        ok: false,
        reason: 'pet-unavailable',
        messages: [],
        bufferedEvents: []
      } satisfies WorkHistoryPayload
    }
    return new Promise<WorkHistoryPayload>((resolve) => {
      const timer = setTimeout(() => {
        pendingHistory.delete(payload.requestId)
        resolve({
          requestId: payload.requestId,
          ok: false,
          reason: 'timeout',
          messages: [],
          bufferedEvents: []
        })
      }, REQUEST_TIMEOUT_MS)
      pendingHistory.set(payload.requestId, { resolve, timer })
      sendToPet(IPC_WORK.HISTORY_REQUEST, payload)
    })
  })

  ipcMain.on(IPC_WORK.HISTORY, (event, raw: unknown) => {
    if (!isPetSender(event.sender)) return
    const payload = raw as WorkHistoryPayload
    if (payload === null || typeof payload !== 'object') return
    const pending = pendingHistory.get(payload.requestId)
    if (pending === undefined) return
    clearTimeout(pending.timer)
    pendingHistory.delete(payload.requestId)
    pending.resolve(payload)
  })

  console.log('[work] IPC 处理器已注册')
}
