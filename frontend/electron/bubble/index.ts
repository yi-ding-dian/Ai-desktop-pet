/**
 * 气泡窗域（用户定稿"气泡系统"第一步）：**独立透明气泡窗** + 标准气泡内容编排。
 *
 * 为什么独立窗口：宠物窗口仅 400×400、兔子占中间，气泡放不下会被窗口裁掉。
 * 故气泡做独立透明小窗（窗口技术照 fx 球窗/自绘托盘菜单先例：transparent + frame:false +
 * alwaysOnTop(screen-saver) + skipTaskbar + Linux type:'toolbar'），**动态尺寸**——渲染侧
 * ResizeObserver 测内容尺寸 → REPORT_SIZE 上报 → 本域 setBounds 调窗（首帧先用预估尺寸定位，
 * 宁大勿小防内容被裁，收到真实尺寸后收紧重定位）。
 *
 * 交互两态（参数已留，本期实际只用菜单态）：
 *  - 菜单态（interactive=true，本任务）：窗口可聚焦——弹出时 show+focus（像原生右键菜单）；
 *    点击别处 → blur → 自动收起（标准弹窗行为）；
 *  - 纯展示态（interactive=false，场景3 说话气泡预留）：不聚焦（showInactive）+ 鼠标穿透
 *    （setIgnoreMouseEvents(true)），不注册 blur 收起。
 *
 * 定位（防出屏）：锚点 = 宠物窗位置 + 兔子头部固定偏移（HEAD_ANCHOR_OFFSET，先取"窗口右上方"，
 * 场景3 再实测精调）；摆放纯函数见 geometry.ts（优先后上 tail=down，放不下翻向 tail=up，
 * 横向夹进工作区）。尺寸上报引发翻向变化时经 SET_TAIL 轻量下发（仅换样式，不重播动画）。
 *
 * 动画分工（照 IPC_FX 先例：主进程是指挥、渲染页负责"画"）：入场"手来手回"在气泡窗内播
 * （光点从爪子方向飞入展开 / 退场收回）；收起 = 本域先发 REQUEST_CLOSE → 渲染侧播退场动画
 * → CLOSED 回报 → 本域 hide（渲染异常时 CLOSE_TIMEOUT_MS 超时兜底强制 hide）。
 *
 * 动作分发（气泡窗 → ACTION → 本域执行）：教学 enter/exit（按 teaching 域当前态二选一）、
 * 打开设置 openSettings、隐藏 runHideAnimation、"清空聊天"先换确认气泡（不关窗）、
 * 确认后向宠物窗发 CHAT_CLEAR_REQUESTED（清空逻辑归后续任务）。动作白名单按当前内容校验。
 *
 * 生命周期：懒创建后常驻（hide 复用，右键重复弹不重窗）；退出（will-quit）destroy。
 */
import { app, BrowserWindow, ipcMain, screen, type WebContents } from 'electron'
import { join } from 'node:path'
import {
  IPC,
  IPC_BUBBLE,
  IPC_EVENTS,
  type BubbleMenuItemPayload,
  type BubbleOpenPayload,
  type BubbleRequest,
  type BubbleTail
} from '../ipc/channels'
import { runHideAnimation } from '../fx'
import { openSettings } from '../settings'
import { enterTeaching, exitTeaching, getTeachingMode } from '../teaching'
import { computeBubblePlacement } from './geometry'
import type { Point, Size } from '../window'

const isDev = !app.isPackaged

/**
 * 兔子头部锚点偏移（宠物窗内坐标）。先取"窗口右上方"固定值（用户定稿：气泡从兔子头右上方
 * 展开、尾巴朝左下指向兔子头）——窗口 400×400、兔子视觉范围约 x 65–335 / y 8–348，
 * 锚点取右侧头肩一带。场景3（说话气泡跟随）再做实测精调；改宠物形象/窗口尺寸时同步调整。
 */
const HEAD_ANCHOR_OFFSET: Point = { x: 255, y: 92 }

/**
 * 各形态预估尺寸（px；show 前先用它定位——真实尺寸经 REPORT_SIZE 收紧重定位）。
 * 与渲染侧 bubble.css 的内容尺寸大致对齐（宁大勿小：大了透明区稍多，小了内容被裁）。
 */
const ESTIMATED_SIZE: Record<'menu' | 'confirm' | 'text', Size> = {
  menu: { width: 216, height: 200 },
  confirm: { width: 236, height: 150 },
  text: { width: 260, height: 140 }
}

/** 内容尺寸收敛范围（setBounds 用；下限防零尺寸，上限防极端长文本撑爆窗口） */
const MIN_SIZE: Size = { width: 120, height: 60 }
const MAX_SIZE: Size = { width: 420, height: 420 }

/** 等待气泡页就绪超时（ms） */
const READY_TIMEOUT_MS = 2500
/** show 后延迟补发内容（ms）：did-finish-load 早于 React 订阅建立时首帧可能丢失的兜底（幂等，按 session 去重） */
const OPEN_REPOST_MS = 150
/** 退场回报超时（ms）：渲染侧播完退场未回报 CLOSED 时强制 hide 兜底 */
const CLOSE_TIMEOUT_MS = 700

/** 菜单动作 id 白名单（防渲染面误发/脏数据） */
const MENU_ACTION_IDS: readonly string[] = ['teaching', 'settings', 'clear-chat', 'hide-pet']
/** 确认气泡动作 id 白名单（PetBubble 组件的通用语义 id：确认/取消） */
const CONFIRM_ACTION_IDS: readonly string[] = ['confirm', 'cancel']

/** 清空确认文案（用户定稿场景2；确认动作本期只发事件，清空逻辑归后续任务） */
const CLEAR_CHAT_CONFIRM = {
  message: '清空全部聊天记录？',
  confirmLabel: '清空',
  cancelLabel: '取消'
} as const

// ------------------------------------------------------------------ 模块级状态（本域单例）

/** 宠物窗口（initBubble 注入；锚点计算/请求清空路由/隐藏动作的对象） */
let petWin: BrowserWindow | null = null
/** 气泡窗（懒创建；hide 而非 destroy，之后复用——右键重复弹不产生重窗） */
let bubbleWin: BrowserWindow | null = null
/** 气泡页已就绪标志（收到 READY 置位；窗口重建后复位） */
let bubbleReady = false
/** 等待就绪的回调队列（气泡页就绪时统一唤醒） */
let readyWaiters: Array<() => void> = []
/** ipcMain 监听是否已注册（只能注册一次，重复注册会叠加处理器） */
let ipcRegistered = false
/** 弹出流程防重入（等待页面就绪是异步的：防右键连点并发建窗/重复下发） */
let opening = false
/** 收起流程中（已发 REQUEST_CLOSE、等待渲染侧退场回报或超时兜底） */
let closing = false
/** 退场回报超时定时器 */
let closeTimer: NodeJS.Timeout | null = null
/** 弹出会话序号（每次 OPEN 递增；渲染侧按 session 去重——补发同载荷不重播动画） */
let sessionSeq = 0
/** 当前内容载荷（动作白名单校验 / 补发 / tail 更新用） */
let currentPayload: BubbleOpenPayload | null = null
/** 当前锚点（屏幕坐标；本次弹出生命周期内固定——显示期间宠物被拖走不跟随，场景3 再处理） */
let anchor: Point | null = null
/** 当前尾巴朝向（尺寸上报引发翻向时与 lastTail 比较后才下发 SET_TAIL） */
let lastTail: BubbleTail = 'down'
/** 当前是否交互态（菜单态 true；场景3 纯展示态 false——穿透+不聚焦+不注册 blur 收起） */
let interactive = true

// ------------------------------------------------------------------ 工具

/** 向气泡窗发送（窗口缺失/销毁时静默忽略） */
function sendTo(win: BrowserWindow | null, channel: string, payload?: unknown): void {
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return
  try {
    win.webContents.send(channel, payload)
  } catch (err) {
    console.warn(`[bubble] 发送 ${channel} 失败（忽略）：`, err)
  }
}

/** sender 是否宠物窗口（REQUEST_OPEN 只认它——本期唯一合法入口） */
function isPetSender(sender: WebContents): boolean {
  return Boolean(petWin && !petWin.isDestroyed() && sender.id === petWin.webContents.id)
}

/** sender 是否当前受管气泡窗（"气泡面专属"消息只认它） */
function isBubbleSender(sender: WebContents): boolean {
  return Boolean(bubbleWin && !bubbleWin.isDestroyed() && sender.id === bubbleWin.webContents.id)
}

/** REQUEST_OPEN 载荷校验（本期只有 { kind:'menu' }） */
function isMenuRequest(request: unknown): request is BubbleRequest {
  return Boolean(request && typeof request === 'object' && (request as BubbleRequest).kind === 'menu')
}

/** 数值夹取 */
function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi)
}

// ------------------------------------------------------------------ 窗口生命周期

/** 加载气泡页：dev 走 electron-vite 渲染服务器（ELECTRON_RENDERER_URL，同目录 bubble.html）；生产走 out/renderer/bubble.html（与 board/tray-menu 同法） */
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

/** 创建气泡窗（窗口技术照 fx 球窗/自绘托盘菜单先例；见文件头"交互两态"） */
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
    ...(process.platform === 'linux' ? { type: 'toolbar' as const } : {}),
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  // 层级抬到最高（同球窗/菜单窗）：气泡出现时应盖在宠物窗/设置窗之上
  win.setAlwaysOnTop(true, 'screen-saver')

  // dev 态：气泡页 console 转发到主进程 stdout（排障；同宠物窗）
  if (isDev) {
    win.webContents.on('console-message', (_event, _level, message) => {
      console.log(`[bubble-renderer] ${message}`)
    })
  }

  // 失焦自动收起（标准弹窗行为：点别处即收）。仅交互态注册——纯展示态（场景3）不聚焦也无 blur
  win.on('blur', () => {
    if (!interactive) return
    if (!win.isDestroyed() && win.isVisible()) closeBubble('blur（点击别处）')
  })

  win.on('closed', () => {
    if (bubbleWin === win) {
      bubbleWin = null
      bubbleReady = false
    }
  })

  // 加载失败/渲染崩溃兜底：销毁窗口清引用（下次弹出重建重试；与 settings/tray 域同法）
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

/** 取（必要时创建）气泡窗 */
function ensureBubbleWindow(): BrowserWindow {
  if (bubbleWin && !bubbleWin.isDestroyed()) return bubbleWin
  bubbleReady = false
  bubbleWin = createBubbleWindow()
  return bubbleWin
}

/** 等待气泡页就绪（带超时；照 fx/tray 域 waitReady 模式） */
function waitBubbleReady(timeoutMs: number): Promise<boolean> {
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

/** 应用退出清理（will-quit；气泡窗直接销毁，不做额外等待——正常退出不播退场动画） */
export function destroyBubble(): void {
  if (closeTimer) {
    clearTimeout(closeTimer)
    closeTimer = null
  }
  const win = bubbleWin
  bubbleWin = null
  bubbleReady = false
  readyWaiters = []
  opening = false
  closing = false
  currentPayload = null
  anchor = null
  interactive = true
  if (win && !win.isDestroyed()) win.destroy()
}

// ------------------------------------------------------------------ 定位（锚点 + 防出屏摆放）

/** 计算当前锚点（宠物窗位置 + 兔子头部偏移；宠物窗不可用返回 null） */
function computeAnchor(): Point | null {
  const pet = petWin
  if (!pet || pet.isDestroyed()) return null
  const b = pet.getBounds()
  return { x: b.x + HEAD_ANCHOR_OFFSET.x, y: b.y + HEAD_ANCHOR_OFFSET.y }
}

/**
 * 按锚点摆放气泡窗（geometry 纯函数 + 所在显示器工作区）。
 * @returns 摆放决策出的尾巴朝向（调用方负责与 lastTail 比较、必要时下发 SET_TAIL）
 */
function applyPlacement(win: BrowserWindow, size: Size): BubbleTail {
  const a = anchor
  if (!a) return 'down'
  const width = Math.round(clamp(size.width, MIN_SIZE.width, MAX_SIZE.width))
  const height = Math.round(clamp(size.height, MIN_SIZE.height, MAX_SIZE.height))
  const wa = screen.getDisplayNearestPoint({ x: Math.round(a.x), y: Math.round(a.y) }).workArea
  const p = computeBubblePlacement(a, { width, height }, wa)
  win.setBounds({ x: p.x, y: p.y, width, height })
  return p.tail
}

// ------------------------------------------------------------------ 弹出 / 收起

/** 组装菜单载荷（"开始教学" ⇄ "结束"由 teaching 域当前态决定；彩色图标名见 src/shared/icons） */
function buildMenuPayload(): BubbleOpenPayload {
  const teaching = getTeachingMode() === 'teaching'
  const items: BubbleMenuItemPayload[] = [
    { id: 'teaching', label: teaching ? '结束' : '开始教学', icon: 'teaching' },
    { id: 'settings', label: '打开设置', icon: 'settings' },
    { id: 'clear-chat', label: '清空聊天', icon: 'broom' },
    { id: 'hide-pet', label: '隐藏', icon: 'sleep' }
  ]
  return {
    session: ++sessionSeq,
    variant: 'menu',
    tail: 'down',
    motion: { enter: 'hand', exit: 'hand' },
    items
  }
}

/** 组装清空确认载荷（场景2） */
function buildConfirmPayload(): BubbleOpenPayload {
  return {
    session: ++sessionSeq,
    variant: 'confirm',
    tail: 'down',
    motion: { enter: 'hand', exit: 'hand' },
    ...CLEAR_CHAT_CONFIRM
  }
}

/**
 * 气泡收尾（真实隐藏）：清超时定时器 + closing 复位 + hide。
 * 供三处调用：渲染侧 CLOSED 回报、超时兜底、弹出前"半收状态"收尾（右键抢焦点触发 blur 的场景）。
 */
function finishClose(reason: string): void {
  if (closeTimer) {
    clearTimeout(closeTimer)
    closeTimer = null
  }
  closing = false
  const win = bubbleWin
  if (win && !win.isDestroyed() && win.isVisible()) {
    win.hide()
    console.log(`[bubble] 气泡窗已隐藏（${reason}）`)
  }
}

/** 请求收起（blur / 动作执行后）：先让渲染侧播退场动画（手来手回），CLOSED 回报后 hide；超时兜底 */
function closeBubble(reason: string): void {
  const win = bubbleWin
  if (!win || win.isDestroyed() || !win.isVisible() || closing) return
  closing = true
  console.log(`[bubble] 收起气泡（${reason}）——等待渲染侧退场动画回报`)
  sendTo(win, IPC_BUBBLE.REQUEST_CLOSE)
  closeTimer = setTimeout(() => {
    console.warn('[bubble] 退场动画回报超时，强制隐藏收尾')
    finishClose('超时兜底')
  }, CLOSE_TIMEOUT_MS)
}

/**
 * 弹出菜单气泡（本轮唯一入口：宠物窗右键）。
 * 幂等收敛：正在弹出（异步就绪等待中）时忽略重复请求；已在显示 → 重定位 + 重发内容
 * （气泡"弹一下"刷新观感，不重窗）；正在收起（如右键抢焦点触发的 blur 半收）→ 先收尾再开。
 */
async function openMenuBubble(): Promise<void> {
  if (opening) return
  opening = true
  try {
    const pet = petWin
    if (!pet || pet.isDestroyed()) {
      console.warn('[bubble] 宠物窗口不可用，无法弹出气泡')
      return
    }
    // 收起中（右键抢焦点 → blur 已触发收起）→ 直接完成收尾：下面按"重新打开"走一遍（新 session 重播入场）
    if (closing) finishClose('重新弹出前收尾')

    const a = computeAnchor()
    if (!a) return
    anchor = a

    const win = ensureBubbleWindow()
    if (!bubbleReady && !(await waitBubbleReady(READY_TIMEOUT_MS))) {
      console.warn(`[bubble] 气泡页 ${READY_TIMEOUT_MS}ms 未就绪，本次取消弹出`)
      return
    }
    if (win.isDestroyed()) return

    // 组装内容 → 预估尺寸定位（防出屏决定 tail）→ 显示并聚焦（菜单态：像原生右键菜单）
    const payload = buildMenuPayload()
    const tail = applyPlacement(win, ESTIMATED_SIZE.menu)
    currentPayload = { ...payload, tail }
    lastTail = tail

    // 交互两态：菜单态 = 可点 + 聚焦（穿透恢复——防上一轮纯展示态残留）；展示态 = 穿透 + 不聚焦
    win.moveTop() // 与宠物同为 screen-saver 层：显示前 raise 自保（气泡要盖在兔子旁/上）
    win.setIgnoreMouseEvents(!interactive)
    if (interactive) win.show()
    else win.showInactive()
    sendTo(win, IPC_BUBBLE.OPEN, currentPayload)
    // 补发兜底（did-finish-load 早于 React 订阅建立时首帧丢失；同 session 幂等）
    setTimeout(() => {
      if (bubbleWin === win && win.isVisible() && !closing && currentPayload?.variant === 'menu') {
        sendTo(win, IPC_BUBBLE.OPEN, currentPayload)
      }
    }, OPEN_REPOST_MS)
    console.log(`[bubble] 菜单气泡已弹出 @ ${win.getBounds().x},${win.getBounds().y}（tail=${tail}）`)
  } catch (err) {
    console.error('[bubble] 弹出菜单气泡异常：', err)
  } finally {
    opening = false
  }
}

/**
 * 菜单"清空聊天" → 换成确认气泡（场景2）：同一气泡窗换内容（不关窗）——
 * 新 session 载荷下发，渲染侧重播一次"手来手回"入场；窗口按确认预估尺寸重定位。
 */
function switchToConfirmBubble(): void {
  const win = bubbleWin
  if (!win || win.isDestroyed() || !win.isVisible()) return
  const payload = buildConfirmPayload()
  const tail = applyPlacement(win, ESTIMATED_SIZE.confirm)
  currentPayload = { ...payload, tail }
  lastTail = tail
  sendTo(win, IPC_BUBBLE.OPEN, currentPayload)
  console.log('[bubble] 已切换为清空确认气泡')
}

/** 向宠物窗发"请求清空聊天"（【清空】确认后；清空逻辑归后续任务——宠物窗侧本期只留 console 占位） */
function requestClearChat(): void {
  const pet = petWin
  if (!pet || pet.isDestroyed() || pet.webContents.isDestroyed()) {
    console.warn('[bubble] 宠物窗口不可用，请求清空聊天未送达')
    return
  }
  pet.webContents.send(IPC_EVENTS.CHAT_CLEAR_REQUESTED)
  console.log('[bubble] 已向宠物窗发出「请求清空聊天」（清空逻辑归后续任务）')
}

/**
 * 分发气泡动作（白名单按当前内容校验——防渲染面误发）。
 * 教学动作按 teaching 域当前态二选一（菜单 label 由同一状态决定）；动作执行与退场动画并行
 * （先执行再 closeBubble 会让用户等待 280ms 退场——反过来零延迟且观感更顺）。
 */
function dispatchAction(id: string): void {
  const payload = currentPayload
  if (!payload) return
  const allowed =
    payload.variant === 'menu'
      ? MENU_ACTION_IDS.includes(id)
      : payload.variant === 'confirm'
        ? CONFIRM_ACTION_IDS.includes(id)
        : false
  if (!allowed) {
    console.warn(`[bubble] 忽略非法动作 id：${id}`)
    return
  }
  console.log(`[bubble] 动作：${id}`)

  switch (id) {
    case 'teaching':
      if (getTeachingMode() === 'teaching') void exitTeaching('menu')
      else void enterTeaching('menu')
      closeBubble('动作：教学')
      break
    case 'settings':
      openSettings()
      closeBubble('动作：设置')
      break
    case 'hide-pet': {
      const pet = petWin
      if (pet && !pet.isDestroyed()) void runHideAnimation(pet)
      closeBubble('动作：隐藏')
      break
    }
    case 'clear-chat':
      // 清空 = 破坏性操作：先换确认气泡（不关窗），确认后才执行
      switchToConfirmBubble()
      break
    case 'confirm':
      requestClearChat()
      closeBubble('动作：清空确认')
      break
    case 'cancel':
      closeBubble('动作：清空取消')
      break
    default:
      break
  }
}

// ------------------------------------------------------------------ IPC 接线（渲染 → 主）

/**
 * 注册气泡域 IPC 处理器（main.ts 在 app ready 后调用一次）。
 * @param pet 宠物窗口（锚点计算/请求清空路由/隐藏动作的对象；注入方式同 teaching/settings 域）
 */
export function initBubble(pet: BrowserWindow): void {
  petWin = pet
  if (ipcRegistered) return
  ipcRegistered = true

  // 弹出请求：唯一入口 = 宠物窗（右键菜单）；其它渲染面/脏载荷一律忽略
  ipcMain.on(IPC.BUBBLE_REQUEST_OPEN, (event, request: unknown) => {
    if (!isPetSender(event.sender)) return
    if (!isMenuRequest(request)) return
    console.log('[bubble] 收到弹出请求（menu）')
    void openMenuBubble()
  })

  // 气泡页就绪：唤醒等待队列
  ipcMain.on(IPC_BUBBLE.READY, (event) => {
    if (!isBubbleSender(event.sender)) return
    bubbleReady = true
    const waiters = readyWaiters
    readyWaiters = []
    waiters.forEach((fn) => fn())
  })

  // 内容尺寸上报：按真实尺寸重定位（防出屏）；翻向变化时 SET_TAIL 轻量下发（不重播动画）
  ipcMain.on(IPC_BUBBLE.REPORT_SIZE, (event, size: unknown) => {
    if (!isBubbleSender(event.sender)) return
    const win = bubbleWin
    if (!win || win.isDestroyed() || !win.isVisible() || closing) return
    const s = size as { width?: unknown; height?: unknown } | null
    const width = Number(s?.width)
    const height = Number(s?.height)
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return
    const tail = applyPlacement(win, { width, height })
    if (tail !== lastTail) {
      lastTail = tail
      sendTo(win, IPC_BUBBLE.SET_TAIL, tail)
    }
    if (currentPayload) currentPayload = { ...currentPayload, tail }
    console.log(
      `[bubble] 尺寸上报 ${Math.round(width)}x${Math.round(height)} → 窗 ${win.getBounds().width}x${win.getBounds().height}（tail=${tail}）`
    )
  })

  // 用户动作：按当前内容白名单校验后分发
  ipcMain.on(IPC_BUBBLE.ACTION, (event, id: unknown) => {
    if (!isBubbleSender(event.sender)) return
    if (typeof id !== 'string') return
    dispatchAction(id)
  })

  // 退场动画播毕：真正隐藏窗口收尾
  ipcMain.on(IPC_BUBBLE.CLOSED, (event) => {
    if (!isBubbleSender(event.sender)) return
    if (!closing) return
    finishClose('渲染侧退场回报')
  })

  console.log('[bubble] IPC 处理器已注册')
}
