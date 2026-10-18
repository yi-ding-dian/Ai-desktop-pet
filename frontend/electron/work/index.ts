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
  IPC_WORK,
  type WorkHistoryPayload,
  type WorkHistoryRequestPayload,
  type WorkMirrorEvent,
  type WorkSendRequestPayload,
  type WorkSendResultPayload
} from '../ipc/channels'
import { PET_WINDOW_SIZE, type Point, type Rect } from '../window'
import { attachFrameless, framelessBounds } from '../window/frameless'
import { podiumPoint } from '../teaching/geometry'
import { getTeachingMode } from '../teaching'
import { runRelocateAnimation } from '../ball-animation'
import { WorkBrowser } from './browser'

const isDev = !app.isPackaged

/** 默认尺寸与最小尺寸（DIP） */
const WORK_DEFAULT_WIDTH = 900
const WORK_DEFAULT_HEIGHT = 780
const WORK_MIN_WIDTH = 560
const WORK_MIN_HEIGHT = 520
const WORK_EDGE_MARGIN = 10

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
 * 进入工作模式前的宠物原位（关闭/最小化时回位目标；只记坐标，尺寸用
 * PET_WINDOW_SIZE——fractional DPI 下 getBounds 的宽高是舍入值）。
 * petPlaced = 宠物当前是否被工作窗"占用"（防止 show/hide 重复触发时重复回位）。
 */
let petHomeRect: Rect | null = null
let petPlaced = false
/** 退出流程（before-quit 置位）：不再拦截 close，避免最后一个窗口关不掉 */
let quitting = false
let ipcRegistered = false

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

/** 工作窗是否正在使用（可见且未最小化）——宠物依附/自主行为抑制的依据 */
function workWindowActive(): boolean {
  const win = workWin
  return win !== null && !win.isDestroyed() && win.isVisible() && !win.isMinimized()
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

/**
 * 工作窗左侧的宠物落点（与教学讲台同几何）。
 * 工作窗被拖到屏幕最左时，讲台点会落到屏幕外——夹回工作区左缘，让兔子
 * 贴着窗口左侧、部分叠在窗口上，而不是整窗消失。
 */
function workAttachPoint(rect: Rect): Point {
  const point = podiumPoint(rect)
  const wa = screen.getDisplayMatching(rect).workArea
  return { x: Math.max(wa.x + 8, point.x), y: point.y }
}

/**
 * 宠物依附到工作窗左侧（与教学模式讲台同一套几何：图像右缘贴窗左下角、脚底与窗底平齐）。
 * 只有工作窗首次显示时才记原位；重复 show（最小化恢复）不会覆盖原位。
 */
function placePet(rect: Rect): void {
  if (petPlaced) return
  // 教学模式优先：两边同时在场时不去抢讲台位
  if (getTeachingMode() !== 'normal') return
  const pet = petWin
  if (pet === null || pet.isDestroyed()) return
  const bounds = pet.getBounds()
  petHomeRect = {
    x: bounds.x,
    y: bounds.y,
    width: PET_WINDOW_SIZE.width,
    height: PET_WINDOW_SIZE.height
  }
  petPlaced = true
  const point = workAttachPoint(rect)
  console.log(
    `[work] 宠物依附工作窗左侧：${bounds.x},${bounds.y} → ${point.x},${point.y}（原位 ${petHomeRect.x},${petHomeRect.y}）`
  )
  void runRelocateAnimation(
    pet,
    {
      x: point.x,
      y: point.y,
      width: PET_WINDOW_SIZE.width,
      height: PET_WINDOW_SIZE.height
    },
    { forceGlide: true }
  )
}

/** 关闭/最小化工作窗：宠物滑步回进入工作模式前的位置（教学模式下让教学域自己管） */
function returnPetHome(): void {
  if (!petPlaced) return
  petPlaced = false
  const home = petHomeRect
  petHomeRect = null
  const pet = petWin
  if (pet === null || pet.isDestroyed() || home === null) return
  if (getTeachingMode() !== 'normal') return
  console.log(`[work] 关闭工作窗，宠物回位 → ${home.x},${home.y}`)
  void runRelocateAnimation(pet, home, { forceGlide: true })
}

/**
 * 工作窗被拖动/缩放：宠物同帧跟到新的左缘（与教学 followPodium 同语义）。
 * 尺寸用设计常量，避免 fractional DPI 下把舍入宽高回喂。
 */
function followPetToWork(rect: Rect): void {
  if (!petPlaced) return
  if (getTeachingMode() !== 'normal') return
  const pet = petWin
  if (pet === null || pet.isDestroyed() || !pet.isVisible()) return
  const point = workAttachPoint(rect)
  pet.setBounds({
    x: point.x,
    y: point.y,
    width: PET_WINDOW_SIZE.width,
    height: PET_WINDOW_SIZE.height
  })
}

function defaultWorkRect(): Rect {
  // 跟随宠物所在显示器；宠物窗不可用时退回主屏
  const wa =
    petWin !== null && !petWin.isDestroyed()
      ? screen.getDisplayMatching(petWin.getBounds()).workArea
      : screen.getPrimaryDisplay().workArea
  const width = Math.min(WORK_DEFAULT_WIDTH, Math.max(WORK_MIN_WIDTH, wa.width - 80))
  const height = Math.min(WORK_DEFAULT_HEIGHT, Math.max(WORK_MIN_HEIGHT, wa.height - 80))
  return {
    x: wa.x + wa.width - width - 40,
    y: wa.y + Math.round((wa.height - height) / 2),
    width,
    height
  }
}

// ------------------------------------------------------------------ 窗口生命周期

function createWorkWindow(): BrowserWindow {
  const initial = workRectOverride ?? defaultWorkRect()
  const win = new BrowserWindow({
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
    skipTaskbar: false,
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
      // 用户拖动/缩放工作窗：宠物同帧跟到新的左缘
      followPetToWork(rect)
    }
  })

  // 显示 = 宠物依附到左侧；隐藏/最小化 = 滑步回原位（退出流程除外）
  win.on('show', () => {
    if (workWin !== win || quitting) return
    notifyPresence(true)
    placePet(framelessBounds(win))
  })
  win.on('hide', () => {
    if (workWin !== win || quitting) return
    notifyPresence(true)
    returnPetHome()
  })
  win.on('minimize', () => {
    if (workWin !== win || quitting) return
    notifyPresence(true)
    returnPetHome()
  })
  win.on('restore', () => {
    if (workWin !== win || quitting) return
    notifyPresence(true)
    placePet(framelessBounds(win))
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
    workWin = null
    workReady = false
    eventBuffer = []
    workBrowser?.destroy()
    workBrowser = null
    rejectAll('work-window-closed')
    notifyPresence(false)
    if (!quitting) returnPetHome()
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
    if (!quitting) returnPetHome()
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

/** 打开工作窗（单例：已存在则还原 + 聚焦） */
export function openWork(): void {
  const existing = workWin
  if (existing !== null && !existing.isDestroyed()) {
    if (existing.isMinimized()) existing.restore()
    existing.show()
    existing.focus()
    notifyPresence(true)
    // 教学模式退出等边缘时序下可能没被占用：补一次依附（已占用时是空操作）
    if (!petPlaced) placePet(framelessBounds(existing))
    return
  }
  createWorkWindow()
  notifyPresence(true)
}

/** 应用退出清理（will-quit） */
export function destroyWork(): void {
  quitting = true
  const win = workWin
  workWin = null
  workReady = false
  eventBuffer = []
  workBrowser?.destroy()
  workBrowser = null
  petPlaced = false
  petHomeRect = null
  rejectAll('app-quit')
  notifyPresence(false)
  if (win !== null && !win.isDestroyed()) win.destroy()
}

// ------------------------------------------------------------------ 入站校验

function normalizeSendPayload(raw: unknown): WorkSendRequestPayload | null {
  if (typeof raw !== 'object' || raw === null) return null
  const value = raw as Record<string, unknown>
  if (typeof value.requestId !== 'string' || value.requestId.length === 0) return null
  if (typeof value.text !== 'string') return null
  const attachments = Array.isArray(value.attachments)
    ? value.attachments
        .map((item) =>
          typeof item === 'object' && item !== null
            ? {
                path: typeof (item as Record<string, unknown>).path === 'string'
                  ? ((item as Record<string, unknown>).path as string)
                  : '',
                name: typeof (item as Record<string, unknown>).name === 'string'
                  ? ((item as Record<string, unknown>).name as string)
                  : ''
              }
            : null
        )
        .filter((item): item is { path: string; name: string } => item !== null && item.path.length > 0)
    : []
  const optionsRaw =
    typeof value.options === 'object' && value.options !== null
      ? (value.options as Record<string, unknown>)
      : {}
  return {
    requestId: value.requestId,
    text: value.text,
    attachments,
    options: {
      think: optionsRaw.think === true,
      search: optionsRaw.search !== false
    }
  }
}

function normalizeHistoryPayload(raw: unknown): WorkHistoryRequestPayload | null {
  if (typeof raw !== 'object' || raw === null) return null
  const value = raw as Record<string, unknown>
  if (typeof value.requestId !== 'string' || value.requestId.length === 0) return null
  const limit =
    typeof value.limit === 'number' && Number.isFinite(value.limit)
      ? Math.max(1, Math.min(500, Math.trunc(value.limit)))
      : 200
  return { requestId: value.requestId, limit }
}

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
    workWin?.minimize()
  })

  ipcMain.on(IPC_WORK.READY, (event) => {
    if (!isWorkSender(event.sender)) return
    workReady = true
    const buffered = eventBuffer
    eventBuffer = []
    for (const item of buffered) sendToWork(IPC_WORK.EVENT, item)
    // 渲染面重载后浏览器标签状态需要补发（视图仍在主进程活着）
    workBrowser?.sendState()
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
