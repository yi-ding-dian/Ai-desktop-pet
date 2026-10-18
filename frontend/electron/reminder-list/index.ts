/**
 * 提醒列表窗域（2026-10-18）：贴在宠物右侧的未读提醒面板。
 *
 * 为什么独立窗（不复用气泡窗）：回复气泡是瞬态的、且与提醒列表要能同时存在；
 * 列表需要在用户不点气泡时持续显示（未读不清就不消失），生命周期独立更简单。
 *
 * 数据流（照 board/bubble 的"哑渲染面"先例）：
 *   宠物窗（唯一 WS 连接）收到 get_reminders 快照 → IPC_REMINDER_LIST.UPDATE
 *   → 本域摆窗/转发 → 列表页渲染；列表页点击条目 → ACTION → 本域转回宠物窗
 *   → 宠物窗发 ack_reminders → 新快照再回来。
 *
 * 定位：右侧优先；右侧不够翻左侧；两侧都不够用紧凑条（待看 N 条，点击展开）。
 * 纯函数见 geometry.ts。宠物移动时跟随重摆；教学/向导/宠物隐藏时由宠物面传 visible=false。
 */
import { app, BrowserWindow, ipcMain, Menu, screen, type WebContents } from 'electron'
import { join } from 'node:path'
import { linuxOnlyWindowOptions } from '../platform'
import {
  IPC_EVENTS,
  IPC_REMINDER_LIST,
  type ReminderListActionPayload,
  type ReminderListOpenPayload,
  type ReminderListUpdatePayload
} from '../ipc/channels'
import { computeReminderListPlacement } from './geometry'
import type { Rect, Size } from '../window'

const isDev = !app.isPackaged
const FOLLOW_THROTTLE_MS = 16
const READY_TIMEOUT_MS = 2000
const DEFAULT_FULL_SIZE: Size = { width: 180, height: 220 }

let petWin: BrowserWindow | null = null
let listWin: BrowserWindow | null = null
let listReady = false
let ipcRegistered = false
let readyWaiters: Array<() => void> = []

/** 宠物面上报的最新未读快照 */
let latest: ReminderListUpdatePayload | null = null
/** 列表页上报的完整面板尺寸（紧凑态不覆盖它） */
let contentSize: Size | null = null
/** 最近一次实际 setBounds 的值（防高频重复 setBounds / 尺寸上报回声） */
let lastAppliedBounds: Rect | null = null
/** 当前是否为紧凑条 */
let compactNow = false
/** 用户从紧凑条点了展开（即使空间不足也尽量展开） */
let forceFull = false
let followPending = false

function sendTo(win: BrowserWindow | null, channel: string, payload?: unknown): void {
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return
  try {
    win.webContents.send(channel, payload)
  } catch (err) {
    console.warn(`[reminder-list] 发送 ${channel} 失败（忽略）：`, err)
  }
}

function isPetSender(sender: WebContents): boolean {
  return Boolean(petWin && !petWin.isDestroyed() && sender.id === petWin.webContents.id)
}

function isListSender(sender: WebContents): boolean {
  return Boolean(listWin && !listWin.isDestroyed() && sender.id === listWin.webContents.id)
}

function loadListPage(win: BrowserWindow): void {
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (isDev && devUrl) {
    try {
      void win.loadURL(new URL('reminder-list.html', devUrl).toString())
      return
    } catch (err) {
      console.warn(`[reminder-list] ELECTRON_RENDERER_URL 非法（${devUrl}），回退 loadFile：`, err)
    }
  }
  void win.loadFile(join(__dirname, '../renderer/reminder-list.html'))
}

function createListWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: DEFAULT_FULL_SIZE.width,
    height: DEFAULT_FULL_SIZE.height,
    show: false,
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
    ...linuxOnlyWindowOptions(),
    webPreferences: {
      preload: join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  win.setIgnoreMouseEvents(false)
  win.on('closed', () => {
    listWin = null
    listReady = false
    readyWaiters = []
    lastAppliedBounds = null
    contentSize = null
  })
  loadListPage(win)
  return win
}

function ensureListWindow(): BrowserWindow {
  if (listWin && !listWin.isDestroyed()) return listWin
  listWin = createListWindow()
  listReady = false
  return listWin
}

function waitReady(timeoutMs: number): Promise<boolean> {
  if (listReady) return Promise.resolve(true)
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs)
    readyWaiters.push(() => {
      clearTimeout(timer)
      resolve(true)
    })
  })
}

function hideList(): void {
  forceFull = false
  if (listWin && !listWin.isDestroyed() && listWin.isVisible()) {
    listWin.hide()
    console.log('[reminder-list] 未读清空/隐藏 → 收起列表窗')
  }
}

function currentOpenPayload(): ReminderListOpenPayload {
  return {
    mode: latest?.mode ?? 'unread',
    items: latest?.items ?? [],
    unreadCount: latest?.unreadCount ?? 0,
    compact: compactNow
  }
}

function sendOpen(): void {
  if (!listReady) return
  sendTo(listWin, IPC_REMINDER_LIST.OPEN, currentOpenPayload())
}

/**
 * 重算并应用摆放（compact 由几何决定；forceFull 时即使空间不足也尽量展开）。
 * ``sendContent``：是否把最新内容重新下发给列表页——宠物移动跟随只调窗口位置，
 * 不能每帧重发内容（否则 React 每帧 setState）。
 */
function applyPlacement(force = false, sendContent = false): void {
  const win = listWin
  const pet = petWin
  if (!win || win.isDestroyed() || !pet || pet.isDestroyed()) return
  const petBounds = pet.getBounds()
  const wa = screen.getDisplayMatching(petBounds).workArea
  // 始终以"完整面板尺寸"参与几何计算：compact 由几何函数按空间决定，
  // 不能因为上一轮是紧凑态就只传紧凑尺寸（否则空间恢复后仍按 104px 算宽度）。
  const fullSize = contentSize ?? DEFAULT_FULL_SIZE
  const placement = computeReminderListPlacement(
    petBounds,
    fullSize,
    wa,
    force || forceFull
  )
  const wasCompact = compactNow
  compactNow = placement.compact

  // 几何结果已包含可用空间夹取（compact 固定小尺寸；forceFull 最小 140）
  const next: Rect = {
    x: placement.x,
    y: placement.y,
    width: placement.width,
    height: placement.height
  }
  const prev = lastAppliedBounds
  const same =
    prev !== null &&
    prev.x === next.x &&
    prev.y === next.y &&
    prev.width === next.width &&
    prev.height === next.height
  if (!same) {
    win.setBounds(next)
    lastAppliedBounds = next
  }
  if (sendContent || wasCompact !== compactNow) sendOpen()
}

/** 强制重绘兜底：透明窗延迟显示时偶发"有布局无画面"，invalidate 促一次全量绘制 */
function forceRepaint(win: BrowserWindow | null): void {
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return
  try {
    win.webContents.invalidate()
  } catch (err) {
    console.warn('[reminder-list] 强制重绘失败（忽略）：', err)
  }
}

async function openList(): Promise<void> {
  const data = latest
  // 未读视图空了就收起；今日视图即使 0 条也保留窗口显示“今天还没有提醒”，方便切回未读
  const emptyUnread =
    data?.mode === 'unread' && (data.unreadCount <= 0 || data.items.length === 0)
  if (!data || !data.visible || emptyUnread) {
    hideList()
    return
  }
  const win = ensureListWindow()
  if (!listReady && !(await waitReady(READY_TIMEOUT_MS))) {
    console.warn(`[reminder-list] 列表页 ${READY_TIMEOUT_MS}ms 未就绪，本次不显示`)
    return
  }
  if (latest !== data) return // 等待期间快照已更新：让新的一次 UPDATE 处理

  if (win.isVisible()) {
    // 已在显示：只更新位置/内容
    applyPlacement(forceFull, true)
    win.moveTop()
    return
  }

  // 首次显示（或从隐藏恢复）：先定位 → 显示 → 再下发内容 → 强制重绘。
  // 顺序与气泡窗一致（气泡也是 showInactive 后才 OPEN + invalidate）；透明窗在隐藏态
  // 先塞内容再 show 时，Windows 上真机出现过"窗口有尺寸、DOM 有内容、屏幕不画"的问题。
  applyPlacement(forceFull, false)
  win.moveTop()
  win.showInactive()
  sendOpen()
  forceRepaint(win)
  setTimeout(() => {
    if (win.isDestroyed() || !win.isVisible()) return
    forceRepaint(win)
  }, 60)
}

function onPetMoved(): void {
  if (followPending || !listWin || listWin.isDestroyed() || !listWin.isVisible()) return
  followPending = true
  setTimeout(() => {
    followPending = false
    if (!listWin || listWin.isDestroyed() || !listWin.isVisible()) return
    applyPlacement(forceFull)
  }, FOLLOW_THROTTLE_MS)
}

function forwardAction(action: ReminderListActionPayload): void {
  const pet = petWin
  if (!pet || pet.isDestroyed() || pet.webContents.isDestroyed()) return
  pet.webContents.send(IPC_EVENTS.REMINDER_LIST_ACTION, action)
}

/** 注册提醒列表 IPC（main.ts 在 app ready 后调用一次） */
export function initReminderList(pet: BrowserWindow): void {
  petWin = pet
  if (ipcRegistered) return
  ipcRegistered = true
  pet.on('move', onPetMoved)

  ipcMain.on(IPC_REMINDER_LIST.UPDATE, (event, payload: unknown) => {
    if (!isPetSender(event.sender)) return
    const raw = payload as ReminderListUpdatePayload | null
    if (!raw || !Array.isArray(raw.items)) return
    const items = raw.items
      .filter((item) => item && typeof item.id === 'string' && typeof item.text === 'string')
      .map((item) => ({
        id: item.id,
        text: item.text,
        timeText: typeof item.timeText === 'string' ? item.timeText : '',
        late: item.late === true,
        acknowledged: item.acknowledged === true
      }))
    const unreadCount = Number(raw.unreadCount)
    latest = {
      mode: raw.mode === 'today' ? 'today' : 'unread',
      items,
      unreadCount: Number.isFinite(unreadCount) ? Math.max(0, Math.round(unreadCount)) : items.length,
      visible: raw.visible !== false
    }
    const emptyUnread =
      latest.mode === 'unread' && (latest.unreadCount === 0 || latest.items.length === 0)
    if (!latest.visible || emptyUnread) {
      hideList()
      return
    }
    void openList()
  })

  ipcMain.on(IPC_REMINDER_LIST.READY, (event) => {
    if (!isListSender(event.sender)) return
    listReady = true
    const waiters = readyWaiters
    readyWaiters = []
    waiters.forEach((fn) => fn())
    // 页面就绪时窗口通常还隐藏着（openList 随后会显示并下发内容）；
    // 只有已经可见（页面重载场景）才立即补内容，避免"隐藏态先塞内容再 show"。
    if (listWin && !listWin.isDestroyed() && listWin.isVisible()) sendOpen()
  })

  ipcMain.on(IPC_REMINDER_LIST.REPORT_SIZE, (event, size: unknown) => {
    if (!isListSender(event.sender)) return
    const s = size as { width?: unknown; height?: unknown } | null
    const width = Number(s?.width)
    const height = Number(s?.height)
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return
    // 紧凑条上报的尺寸不能覆盖完整面板尺寸（展开后还要用回完整尺寸）
    if (!compactNow) contentSize = { width, height }
    if (!compactNow) applyPlacement(forceFull)
  })

  // 列表右键菜单：不再在列表底部放“全部知道了”（占位置），改为右键 → 全部已读
  ipcMain.on(IPC_REMINDER_LIST.CONTEXT_MENU, (event) => {
    if (!isListSender(event.sender)) return
    console.log('[reminder-list] 右键菜单：全部已读')
    const win = listWin
    const menu = Menu.buildFromTemplate([
      {
        label: '全部已读',
        click: () => forwardAction({ type: 'ack-all' })
      }
    ])
    try {
      menu.popup(
        win && !win.isDestroyed() ? { window: win } : { callback: () => undefined }
      )
    } catch (err) {
      console.warn('[reminder-list] 右键菜单弹出失败（忽略）：', err)
    }
  })

  ipcMain.on(IPC_REMINDER_LIST.ACTION, (event, payload: unknown) => {
    if (!isListSender(event.sender)) return
    const action = payload as ReminderListActionPayload | null
    if (!action || typeof action.type !== 'string') return
    if (action.type === 'expand') {
      forceFull = true
      applyPlacement(true, true)
      console.log('[reminder-list] 紧凑条 → 展开完整列表')
      return
    }
    if (action.type === 'ack') {
      if (typeof action.id !== 'string' || !action.id) return
      forwardAction({ type: 'ack', id: action.id })
      return
    }
    if (action.type === 'ack-all') {
      forwardAction({ type: 'ack-all' })
      return
    }
    if (action.type === 'history' || action.type === 'unread') {
      // 视图切换由宠物面统一管：它负责拉取今日历史/未读快照并回推列表内容
      forwardAction({ type: action.type })
    }
  })

  console.log('[reminder-list] IPC 处理器已注册')
}

/** 退出清理（幂等）：销毁列表窗 */
export function destroyReminderList(): void {
  readyWaiters = []
  listReady = false
  latest = null
  contentSize = null
  lastAppliedBounds = null
  compactNow = false
  forceFull = false
  const win = listWin
  listWin = null
  if (win && !win.isDestroyed()) win.destroy()
}
