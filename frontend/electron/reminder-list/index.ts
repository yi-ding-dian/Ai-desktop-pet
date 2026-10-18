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
 * 定位：右侧优先；右侧不够翻左侧；两侧都不够用紧凑条（待看 N 条，点击展开）；
 * 无未读、只有待提醒时缩成 104×38 常驻灰灯小条（点击向下展开，点别处收回）。
 * 纯函数见 geometry.ts。展开/收起/时钟视图切换对窗口 bounds 做 180ms 缓动；
 * 宠物移动时跟随重摆不走动画；教学/向导/宠物隐藏时由宠物面传 visible=false。
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
import {
  computeReminderBellPlacement,
  computeReminderListPlacement
} from './geometry'
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
/** 列表页上报的完整面板尺寸（紧凑态不覆盖它；灰灯展开时是展开后高度） */
let contentSize: Size | null = null
/** 收起态面板尺寸（灰灯收起时立即恢复，避免等下一次 REPORT_SIZE 造成跳动） */
let collapsedSize: Size | null = null
/** 最近一次实际 setBounds 的值（防高频重复 setBounds / 尺寸上报回声） */
let lastAppliedBounds: Rect | null = null
/** 灰灯展开时：面板顶边相对宠物窗 y 的偏移（顶部固定、向下生长） */
let expandedTopOffset: number | null = null
/** 上一轮是否处于“向下展开”态（未读展开 / 时钟视图；用于捕获/清除锚点） */
let wasDownExpanded = false
/** 上一轮是否为常驻灰灯小球（状态切换时重发内容并触发动画） */
let wasBellOnly = false
/** 灰灯当前所在侧（渲染侧据此把灰点/文字贴向宠物） */
let bellSide: 'right' | 'left' = 'right'
/** 窗口 bounds 动画定时器（展开/收起/时钟视图切换用） */
let boundsAnimTimer: ReturnType<typeof setInterval> | null = null
/** 动画时长（ms）：短促但不生硬 */
const BOUNDS_ANIM_MS = 180
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
    cancelBoundsAnimation()
    listWin = null
    listReady = false
    readyWaiters = []
    lastAppliedBounds = null
    contentSize = null
    collapsedSize = null
    expandedTopOffset = null
    wasDownExpanded = false
    wasBellOnly = false
    bellSide = 'right'
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
  cancelBoundsAnimation()
  if (listWin && !listWin.isDestroyed() && listWin.isVisible()) {
    listWin.hide()
    console.log('[reminder-list] 未读/待提醒清空或隐藏 → 收起列表窗')
  }
}

function currentOpenPayload(): ReminderListOpenPayload {
  return {
    mode: latest?.mode ?? 'unread',
    items: latest?.items ?? [],
    unreadCount: latest?.unreadCount ?? 0,
    pendingItems: latest?.pendingItems ?? [],
    pendingExpanded: latest?.pendingExpanded === true,
    pendingCount: latest?.pendingCount ?? 0,
    bellOnly: latest?.bellOnly === true,
    bellSide,
    compact: compactNow
  }
}

function sendOpen(): void {
  if (!listReady) return
  sendTo(listWin, IPC_REMINDER_LIST.OPEN, currentOpenPayload())
}

function cancelBoundsAnimation(): void {
  if (boundsAnimTimer !== null) {
    clearInterval(boundsAnimTimer)
    boundsAnimTimer = null
  }
}

function sameRect(a: Rect, b: Rect): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
}

/**
 * 窗口 bounds 缓动（展开/收起/时钟视图切换）：从当前 bounds 插值到目标，
 * ease-out；动画中来了新目标则从当前帧继续，不跳变。宠物移动跟随不走这里。
 */
function animateBounds(win: BrowserWindow, target: Rect): void {
  const from = win.getBounds()
  if (sameRect(from, target)) {
    win.setBounds(target)
    return
  }
  cancelBoundsAnimation()
  forceRepaint(win)
  const started = Date.now()
  boundsAnimTimer = setInterval(() => {
    if (win.isDestroyed()) {
      cancelBoundsAnimation()
      return
    }
    const t = Math.min(1, (Date.now() - started) / BOUNDS_ANIM_MS)
    const eased = 1 - Math.pow(1 - t, 3)
    const frame: Rect = {
      x: Math.round(from.x + (target.x - from.x) * eased),
      y: Math.round(from.y + (target.y - from.y) * eased),
      width: Math.round(from.width + (target.width - from.width) * eased),
      height: Math.round(from.height + (target.height - from.height) * eased)
    }
    win.setBounds(frame)
    if (t >= 1) {
      cancelBoundsAnimation()
      win.setBounds(target)
      forceRepaint(win)
    }
  }, 16)
}

/**
 * 重算并应用摆放（compact 由几何决定；forceFull 时即使空间不足也尽量展开）。
 * ``sendContent``：是否把最新内容重新下发给列表页——宠物移动跟随只调窗口位置，
 * 不能每帧重发内容（否则 React 每帧 setState）。
 * ``animate``：尺寸/位置变化是否走缓动（展开/收起/视图切换）；宠物移动跟随不走。
 */
function applyPlacement(
  force = false,
  sendContent = false,
  animate = false
): void {
  const win = listWin
  const pet = petWin
  if (!win || win.isDestroyed() || !pet || pet.isDestroyed()) return
  const petBounds = pet.getBounds()
  const wa = screen.getDisplayMatching(petBounds).workArea
  const bellOnly = latest?.bellOnly === true
  // 向下展开态：未读里的灰灯展开 / 时钟视图（显示全部）。
  // 顶部固定、高度向下增加，允许盖住输入框；这样才能一次看全 7~9 条。
  // 普通收起未读面板仍用底边锚定（不压输入框）。
  const downExpanded =
    !bellOnly &&
    (latest?.mode === 'today' ||
      (latest?.mode === 'unread' && latest?.pendingExpanded === true))
  if (downExpanded && !wasDownExpanded && lastAppliedBounds) {
    // 从收起态切到向下展开：记住当前面板顶边，之后顶边固定、高度向下长
    expandedTopOffset = lastAppliedBounds.y - petBounds.y
  } else if (!downExpanded) {
    expandedTopOffset = null
  }
  wasDownExpanded = downExpanded
  // 始终以"完整面板尺寸"参与几何计算：compact 由几何函数按空间决定，
  // 不能因为上一轮是紧凑态就只传紧凑尺寸（否则空间恢复后仍按 104px 算宽度）。
  // 展开时用展开尺寸；收起时优先用收起态尺寸，避免等上报造成跳动。
  const fullSize = downExpanded
    ? contentSize ?? DEFAULT_FULL_SIZE
    : collapsedSize ?? contentSize ?? DEFAULT_FULL_SIZE
  const anchorTop =
    downExpanded && expandedTopOffset !== null
      ? petBounds.y + expandedTopOffset
      : null
  const placement = bellOnly
    ? computeReminderBellPlacement(petBounds, wa)
    : computeReminderListPlacement(
        petBounds,
        fullSize,
        wa,
        force || forceFull,
        anchorTop
      )
  const wasCompact = compactNow
  compactNow = placement.compact
  const wasBell = wasBellOnly
  wasBellOnly = bellOnly
  const prevBellSide = bellSide
  if (bellOnly) bellSide = placement.side
  const bellSideChanged = bellOnly && prevBellSide !== bellSide

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
  // 先切内容再动窗口：展开/收起时内容与尺寸同时过渡，避免旧内容被拉伸。
  // 窗口未显示时不能下发内容（首次显示必须先 show 再 sendOpen，否则 Windows
  // 透明窗会出现“有布局不绘制”的旧问题）。
  if (
    win.isVisible() &&
    (sendContent ||
      wasCompact !== compactNow ||
      wasBell !== bellOnly ||
      bellSideChanged)
  ) {
    sendOpen()
  }
  if (!same) {
    if (animate && win.isVisible()) {
      animateBounds(win, next)
    } else {
      cancelBoundsAnimation()
      win.setBounds(next)
    }
    lastAppliedBounds = next
  }
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
  // 未读视图空了就收起；但用户手动展开灰灯待提醒时保留（即使未读已清空）；
  // 时钟视图即使 0 条也保留窗口显示“还没有提醒”，方便切回未读
  const emptyUnread =
    data?.mode === 'unread' &&
    (data.unreadCount <= 0 || data.items.length === 0) &&
    data.pendingCount <= 0 &&
    !data.pendingExpanded &&
    !data.bellOnly
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
    // 已在显示：更新位置/内容；展开/收起/视图切换走缓动
    applyPlacement(forceFull, true, true)
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
    const sanitize = (items: unknown): ReminderListUpdatePayload['items'] =>
      (Array.isArray(items) ? items : [])
        .filter((item) => item && typeof item.id === 'string' && typeof item.text === 'string')
        .map((item) => ({
          id: item.id,
          text: item.text,
          timeText: typeof item.timeText === 'string' ? item.timeText : '',
          late: item.late === true,
          acknowledged: item.acknowledged === true,
          pending: item.pending === true
        }))
    const items = sanitize(raw.items)
    const pendingItems = sanitize(raw.pendingItems)
    const unreadCount = Number(raw.unreadCount)
    const pendingCount = Number(raw.pendingCount)
    latest = {
      mode: raw.mode === 'today' ? 'today' : 'unread',
      items,
      unreadCount: Number.isFinite(unreadCount) ? Math.max(0, Math.round(unreadCount)) : items.length,
      pendingItems,
      pendingExpanded: raw.pendingExpanded === true,
      pendingCount: Number.isFinite(pendingCount) ? Math.max(0, Math.round(pendingCount)) : pendingItems.length,
      bellOnly: raw.bellOnly === true,
      visible: raw.visible !== false
    }
    const emptyUnread =
      latest.mode === 'unread' &&
      (latest.unreadCount === 0 || latest.items.length === 0) &&
      latest.pendingCount <= 0 &&
      !latest.pendingExpanded &&
      !latest.bellOnly
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
    // 紧凑条/灰灯小球上报的尺寸不能覆盖完整面板尺寸（展开后还要用回完整尺寸）
    if (!compactNow && latest?.bellOnly !== true) {
      contentSize = { width, height }
      const downExpanded =
        latest?.mode === 'today' ||
        (latest?.mode === 'unread' && latest?.pendingExpanded === true)
      // 向下展开态（待提醒面板 / 时钟视图）不覆盖“未读收起态”尺寸
      if (!downExpanded) collapsedSize = { width, height }
      applyPlacement(forceFull, false, true)
    }
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
      applyPlacement(true, true, true)
      console.log('[reminder-list] 紧凑条 → 展开完整列表')
      return
    }
    if (action.type === 'ack' || action.type === 'delete') {
      if (typeof action.id !== 'string' || !action.id) return
      forwardAction({ type: action.type, id: action.id })
      return
    }
    if (action.type === 'ack-all') {
      forwardAction({ type: 'ack-all' })
      return
    }
    if (
      action.type === 'history' ||
      action.type === 'unread' ||
      action.type === 'pending-expand' ||
      action.type === 'pending-collapse'
    ) {
      // 视图切换/灰灯展开由宠物面统一管：它负责拉取历史/未读快照并回推列表内容
      forwardAction({ type: action.type })
    }
  })

  console.log('[reminder-list] IPC 处理器已注册')
}

/** 退出清理（幂等）：销毁列表窗 */
export function destroyReminderList(): void {
  readyWaiters = []
  listReady = false
  cancelBoundsAnimation()
  latest = null
  contentSize = null
  collapsedSize = null
  lastAppliedBounds = null
  expandedTopOffset = null
  wasDownExpanded = false
  wasBellOnly = false
  bellSide = 'right'
  compactNow = false
  forceFull = false
  const win = listWin
  listWin = null
  if (win && !win.isDestroyed()) win.destroy()
}
