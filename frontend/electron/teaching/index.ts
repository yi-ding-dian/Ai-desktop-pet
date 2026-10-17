/**
 * 教学模式（P5，设计文档 §7.5）编排中心：**讲台 + 黑板**。
 *
 * 本域是教学模式的唯一权威（渲染面只读，变化经 TEACHING_STATE_CHANGED 广播）：
 *  - 状态机：normal / teaching-expanded / teaching-folded（folded = 黑板卷成右缘小角标）；
 *  - 黑板窗口生命周期：创建 → 滑入 → 展开 ⇄ 折叠 → 滑出 → 销毁（几何纯函数见 geometry.ts）；
 *  - 消息路由：宠物面镜像事件 → 黑板收件箱；黑板输入条 → 宠物面（由宠物面走既有 WS 链路发送）；
 *  - 下课回位：进入教学前记录宠物原位，退出（含黑板异常降级）后 relocate 回原位
 *    （2026-10-17 用户定稿"关闭白板要回到原来的位置，像关闭设置一样"；与设置域同一回位语义）；
 *  - 首批数据缓存：黑板渲染就绪（TEACHING_READY）前到达的收件箱条目按序缓存（上限 200），
 *    就绪后按序回放（覆盖"黑板窗口创建中/页面加载中"的镜像事件空窗）；
 *  - 异常兜底：黑板 did-fail-load / render-process-gone / 意外关闭 → 重建一次；再失败 → 降级退出；
 *  - dev 逃生门：环境变量 PET_TEACHING_AUTOSTART=1 → app ready 3s 后自动 enter('debug'）
 *    （读取与定时在 main.ts，先例：PET_ANCHOR_SELFTEST）。
 *
 * **不变量**（§7.5.2 镜像方案）：对话主体仍在宠物窗口的 WS 连接上——本域只做编排与转发，
 * 不建立任何第二条连接；黑板是"哑显示"（不认识协议，只认收件箱指令）。
 *
 * 并发安全：所有状态跃迁经 opSeq 序列号串行化——异步动画（滑入/折叠/滑出）完成后若发现
 * 期间已被新操作接管（enter/exit/fold/unfold 交错），则提前返回，不覆盖新状态、不广播陈旧状态。
 */
import { app, BrowserWindow, ipcMain, screen, shell, type WebContents } from 'electron'
import { join } from 'node:path'
import { linuxOnlyWindowOptions } from '../platform'
import {
  IPC,
  IPC_EVENTS,
  type TeachingBoardInbox,
  type TeachingEnterReason,
  type TeachingMirrorEvent,
  type TeachingStatePayload
} from '../ipc/channels'
import {
  BOARD_MIN_WIDTH,
  PODIUM_PET_SIZE,
  expandedBounds,
  foldedBounds,
  offscreenRight,
  podiumPoint
} from './geometry'
import { runRelocateAnimation } from '../ball-animation'
import { PET_WINDOW_SIZE } from '../window'
import type { Rect } from '../window'

const isDev = !app.isPackaged

/** 动画节拍（ms）：主进程无 rAF，用 setInterval(~16ms) 近似 60fps（照 window/move.ts） */
const FRAME_INTERVAL_MS = 16
/** 滑入/滑出时长（ms，§7.5.2） */
const SLIDE_MS = 260
/** 展开 ⇄ 折叠尺寸过渡时长（ms） */
const TRANSITION_MS = 220
/** 收件箱缓存上限（条）：黑板渲染就绪前的镜像事件/跳转/显隐指令按序暂存，超出丢弃最旧 */
const MAX_PENDING_INBOX = 200
/** 单次教学会话内允许的黑板重建次数（超过 → 降级退出教学模式） */
const MAX_BOARD_REBUILDS = 1

/** 内部状态机（对渲染面映射为 TeachingStatePayload.mode: 'normal' | 'teaching' + folded） */
type TeachingMode = 'normal' | 'expanded' | 'folded'

// ------------------------------------------------------------------ 模块级状态（本域单例）

/** 宠物窗口（initTeaching 注入；状态广播与"黑板输入 → 宠物面"路由都靠它） */
let petWin: BrowserWindow | null = null
/** 黑板窗口（懒创建；折叠 = 同一个窗口换尺寸/位置——"角标 = 黑板窗口自身折叠态"，不引入第三窗） */
let boardWin: BrowserWindow | null = null
/** 黑板渲染就绪标志（收到 TEACHING_READY 置位；窗口销毁/重建复位） */
let boardReady = false
/** 收件箱缓存（boardReady=false 期间的 mirror/goto/visibility，按序回放） */
let pendingInbox: TeachingBoardInbox[] = []
/** 状态机当前态 */
let mode: TeachingMode = 'normal'
/** 黑板宽度记忆（用户拖过黑板左缘；null = 未拖过 → 用默认比例；enter/unfold/重建统一经 currentExpandedBounds，会话级有效） */
let boardWidthOverride: number | null = null
/** 操作序列号：每次 enter/exit/fold/unfold 自增；动画后用它判断本操作是否仍有效 */
let opSeq = 0
/** 本次教学会话内的黑板重建计数（enter 时清零） */
let rebuildCount = 0
/**
 * 进入教学前宠物原位（下课回位目标；null = 本次会话没有可回的原位）。
 * 只记坐标，尺寸用 PET_WINDOW_SIZE——fractional DPI 下 getBounds 的宽高是舍入值，
 * 回喂 relocate 会让宠物窗每次开合长大 1px（同 window/index.ts 的约定）。
 */
let petHomeRect: Rect | null = null
/** 窗口动画序列号：新动画抢占旧动画（旧动画提前 resolve、不写终点） */
let animSeq = 0
/** ipcMain 监听是否已注册（只能注册一次，重复注册会叠加处理器） */
let ipcRegistered = false

// ------------------------------------------------------------------ 小工具

/** 缓动：easeInOutQuad（起步/收尾柔和；与 window/move.ts 同款） */
function easeInOutQuad(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - 2 * (1 - t) * (1 - t)
}

/** 向某窗口 webContents 发送（窗口缺失/销毁时静默忽略——黑板生命周期与本域状态可能短暂错位） */
function sendTo(win: BrowserWindow | null, channel: string, payload?: unknown): void {
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return
  try {
    win.webContents.send(channel, payload)
  } catch (err) {
    console.warn(`[teaching] 发送 ${channel} 失败（忽略）：`, err)
  }
}

/** sender 是否宠物窗口（黑板面调用"宠物面专属"方法一律忽略——按契约属无害空操作） */
function isPetSender(sender: WebContents): boolean {
  return Boolean(petWin && !petWin.isDestroyed() && sender.id === petWin.webContents.id)
}

/** sender 是否黑板窗口（宠物面调用"黑板面专属"方法同样忽略） */
function isBoardSender(sender: WebContents): boolean {
  return Boolean(boardWin && !boardWin.isDestroyed() && sender.id === boardWin.webContents.id)
}

/** 宠物窗口中心所在显示器的工作区（黑板落到"宠物所在的屏"，§7.5.2） */
function petWorkArea(): Rect {
  const win = petWin
  if (!win || win.isDestroyed()) return screen.getPrimaryDisplay().workArea
  const b = win.getBounds()
  return screen.getDisplayNearestPoint({
    x: Math.round(b.x + b.width / 2),
    y: Math.round(b.y + b.height / 2)
  }).workArea
}

/** 黑板当前所在显示器的工作区（折叠/恢复/退出就地计算，防跨屏漂移）；黑板不在时退回宠物所在屏 */
function boardWorkArea(): Rect {
  const win = boardWin
  if (win && !win.isDestroyed()) return screen.getDisplayMatching(win.getBounds()).workArea
  return petWorkArea()
}

/** 展开态当前目标矩形（含用户拖过的宽度记忆；enter/unfold/重建三处统一入口） */
function currentExpandedBounds(wa: Rect): Rect {
  return expandedBounds(wa, boardWidthOverride ?? undefined)
}

/**
 * 兔子滑步到讲台位（黑板左下角外侧，geometry.podiumPoint）——**主进程 relocate（forceGlide）**：
 * 不走渲染侧 moveTo（其工作区夹取会让"窗底允许越界"的讲台位停在半路——2026-10-16 真机故障
 * 修复："兔子没有贴到黑板左下角"）；forceGlide 跳过魔法流程（去讲课，不搞"被魔法球捕获"）。
 * enter / unfold 共用；宠物不可用/隐藏时 relocate 内部自动静默处理。
 */
function glidePetToPodium(boardRect: Rect): void {
  const pet = petWin
  if (!pet || pet.isDestroyed()) return
  const p = podiumPoint(boardRect)
  void runRelocateAnimation(
    pet,
    { x: p.x, y: p.y, width: PODIUM_PET_SIZE, height: PODIUM_PET_SIZE },
    { forceGlide: true }
  )
}

/**
 * 下课回位（2026-10-17 用户定稿）：把宠物送回**进入教学前**的位置。
 * 与设置域 returnPetHome 同语义——回位完成由调用方（exitTeaching）决定广播时机，
 * 让宠物面"面板恢复"与宠物落位同步；宠物隐藏时 relocate 内部只静默改坐标（不强行显示）。
 */
async function returnPetHome(): Promise<void> {
  const pet = petWin
  const home = petHomeRect
  petHomeRect = null
  if (!pet || pet.isDestroyed() || !home) return
  const from = pet.getBounds()
  console.log(`[teaching] 下课回位：宠物 ${from.x},${from.y} → ${home.x},${home.y}`)
  await runRelocateAnimation(pet, home)
}

// ------------------------------------------------------------------ 状态广播 / 收件箱

/**
 * 构造状态载荷。
 * podium 仅在"teaching-expanded"时给出（进入/恢复展开 → 宠物走回讲台位）；
 * 折叠态不给——此时宠物正待在被拖到的位置，不该被召回讲台。
 */
function buildPayload(reason: string): TeachingStatePayload {
  const payload: TeachingStatePayload = {
    mode: mode === 'normal' ? 'normal' : 'teaching',
    folded: mode === 'folded',
    reason
  }
  if (mode === 'expanded' && boardWin && !boardWin.isDestroyed()) {
    // 讲台位 = 黑板窗左下角外侧（2026-10-16 定稿）；黑板不可用时不发（渲染侧"无 podium 不走位"）
    payload.podium = podiumPoint(boardWin.getBounds())
  }
  return payload
}

/** 广播状态变化（双端都收：宠物面走位/气泡/面板，黑板面视图） */
function broadcastState(reason: string): void {
  const payload = buildPayload(reason)
  sendTo(petWin, IPC_EVENTS.TEACHING_STATE_CHANGED, payload)
  sendTo(boardWin, IPC_EVENTS.TEACHING_STATE_CHANGED, payload)
  console.log(
    `[teaching] 状态广播：mode=${payload.mode} folded=${payload.folded} reason=${reason}` +
      (payload.podium ? ` podium=${payload.podium.x},${payload.podium.y}` : '')
  )
}

/** 下发黑板收件箱指令；黑板未就绪时入缓存（上限 200，超出丢最旧），就绪后按序回放 */
function sendInbox(item: TeachingBoardInbox): void {
  const win = boardWin
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) {
    console.warn(`[teaching] 黑板不存在，丢弃收件箱指令：${item.type}`)
    return
  }
  if (!boardReady) {
    pendingInbox.push(item)
    if (pendingInbox.length > MAX_PENDING_INBOX) {
      pendingInbox.splice(0, pendingInbox.length - MAX_PENDING_INBOX)
    }
    return
  }
  sendTo(win, IPC_EVENTS.TEACHING_BOARD_INBOX, item)
}

/** 黑板就绪后按序回放缓存（幂等：缓存为空时无操作） */
function flushPendingInbox(): void {
  const win = boardWin
  if (!boardReady || !win || win.isDestroyed() || win.webContents.isDestroyed()) return
  const items = pendingInbox
  pendingInbox = []
  if (items.length === 0) return
  console.log(`[teaching] 黑板已就绪：回放缓存收件箱 ${items.length} 条`)
  for (const item of items) {
    try {
      win.webContents.send(IPC_EVENTS.TEACHING_BOARD_INBOX, item)
    } catch (err) {
      console.warn('[teaching] 回放收件箱失败（中断回放）：', err)
      break
    }
  }
}

// ------------------------------------------------------------------ 窗口动画（轻量版，独立于 window/move.ts）

/**
 * 逐帧缓动黑板窗口 bounds（位置与尺寸同时插值，easeInOutQuad）。
 * 语义：新动画抢占旧动画（旧动画的 interval 立刻退出且不写终点——新动画从当前 bounds 续走）。
 */
function animateBoard(to: Rect, durationMs: number): Promise<void> {
  const win = boardWin
  if (!win || win.isDestroyed()) return Promise.resolve()
  const seq = ++animSeq
  const from = win.getBounds()
  const same =
    from.x === to.x && from.y === to.y && from.width === to.width && from.height === to.height
  if (durationMs <= 0 || same) {
    win.setBounds(to)
    return Promise.resolve()
  }
  return new Promise((resolve) => {
    const t0 = Date.now()
    const timer = setInterval(() => {
      if (seq !== animSeq || win.isDestroyed()) {
        clearInterval(timer)
        resolve()
        return
      }
      const p = Math.min(1, (Date.now() - t0) / durationMs)
      const e = easeInOutQuad(p)
      win.setBounds({
        x: Math.round(from.x + (to.x - from.x) * e),
        y: Math.round(from.y + (to.y - from.y) * e),
        width: Math.round(from.width + (to.width - from.width) * e),
        height: Math.round(from.height + (to.height - from.height) * e)
      })
      if (p >= 1) {
        clearInterval(timer)
        resolve()
      }
    }, FRAME_INTERVAL_MS)
  })
}

// ------------------------------------------------------------------ 黑板窗口生命周期

/**
 * 创建黑板窗口（窗口技术照宠物窗/fx 球窗先例：transparent + frame:false + alwaysOnTop +
 * skipTaskbar + resizable:false；Linux 加 type:'toolbar' 防 DDE Dock 占格）。
 * 与 fx 球窗的区别：黑板要接收输入（底部输入条、× 按钮、角标点击），故**不**开点击穿透、
 * **不**置 focusable:false；层级用默认置顶（不用 screen-saver——魔法球出场时应盖在黑板上方）。
 */
function createBoardWindow(initial: Rect): BrowserWindow {
  const win = new BrowserWindow({
    x: initial.x,
    y: initial.y,
    width: initial.width,
    height: initial.height,
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
    // （type 是 X11 概念，仅 Linux 设置；Wayland 下静默无效，与宠物窗降级路径一致）
    ...linuxOnlyWindowOptions(),
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // 板书流式渲染期间不能被离屏节流（同宠物窗）
      backgroundThrottling: false
    }
  })

  // dev 态：黑板渲染进程 console 转发到主进程 stdout（无 devtools 环境排障；同宠物窗）
  if (isDev) {
    win.webContents.on('console-message', (_event, _level, message) => {
      console.log(`[board-renderer] ${message}`)
    })
  }

  // 外链走系统浏览器（板书 Markdown 里的 http(s) 链接），其余新窗口一律拒绝；返回时黑板重建也不受影响
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://') || url.startsWith('http://')) void shell.openExternal(url)
    return { action: 'deny' }
  })

  attachBoardEvents(win)
  loadBoardPage(win)
  console.log(`[teaching] 黑板窗口已创建（${initial.width}x${initial.height} @ ${initial.x},${initial.y}）`)
  return win
}

/**
 * 加载黑板页：dev 走 electron-vite 渲染服务器（ELECTRON_RENDERER_URL，文件名换成 board.html）；
 * 生产走打包产物 out/renderer/board.html。board.html 由渲染侧（B1）提供，本域只管路径约定。
 */
function loadBoardPage(win: BrowserWindow): void {
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (isDev && devUrl) {
    // 用 URL 相对解析：base 无论是否带尾斜杠/是否带 index.html，都能得到同目录的 board.html
    try {
      void win.loadURL(new URL('board.html', devUrl).toString())
      return
    } catch (err) {
      console.warn(`[teaching] ELECTRON_RENDERER_URL 非法（${devUrl}），回退 loadFile：`, err)
    }
  }
  void win.loadFile(join(__dirname, '../renderer/board.html'))
}

/**
 * 黑板窗口事件接线（每个窗口实例各接一次——重建后新窗口重新接）。
 * 异常兜底只看"当前受管窗口"（boardWin === win）：重建/主动销毁后的旧窗口迟来事件一律忽略，
 * 避免一次崩溃被 did-fail-load + render-process-gone + closed 三连重复处理。
 */
function attachBoardEvents(win: BrowserWindow): void {
  win.on('closed', () => {
    const tracked = boardWin === win
    if (tracked) {
      boardWin = null
      boardReady = false
      // 不清 pendingInbox：意外关闭走重建时尽力回放（主动销毁路径由 destroyBoardWindow 负责清）
    }
    // 主动销毁（destroyBoard 先把 boardWin 置空）不触发兜底；受管窗口意外消失才兜底
    if (tracked) handleBoardFailure('窗口意外关闭（closed）')
  })

  win.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame) return
    if (boardWin !== win) return
    handleBoardFailure(`did-fail-load（${errorCode} ${errorDescription} ${validatedURL}）`)
  })

  win.webContents.on('render-process-gone', (_event, details) => {
    if (boardWin !== win) return
    handleBoardFailure(`render-process-gone（${details.reason}）`)
  })
}

/** 主动销毁黑板窗口（正常退出路径；静默、不触发兜底） */
function destroyBoardWindow(): void {
  const win = boardWin
  boardWin = null
  boardReady = false
  pendingInbox = []
  if (win && !win.isDestroyed()) win.destroy()
}

/**
 * 黑板异常兜底（§7.5.3）：重建一次；再失败 → 降级退出教学模式（广播 normal + 日志）。
 * 重建保留 recent 缓存（尽力恢复板书：已发送过的无法补，未发送的继续），按当前状态直接定位，
 * 不播滑入动画（"恢复"而非"开课"）。
 */
function handleBoardFailure(reason: string): void {
  if (mode === 'normal') return
  console.warn(`[teaching] 黑板异常：${reason}`)
  if (rebuildCount >= MAX_BOARD_REBUILDS) {
    console.error('[teaching] 黑板重建后仍失败 → 降级退出教学模式')
    void exitTeaching('board-failed')
    return
  }
  rebuildCount += 1
  const kept = pendingInbox.slice(-MAX_PENDING_INBOX)
  destroyBoardWindow()
  pendingInbox = kept
  const wa = petWorkArea()
  const target = mode === 'folded' ? foldedBounds(wa) : currentExpandedBounds(wa)
  const win = createBoardWindow(target)
  boardWin = win
  win.showInactive()
  console.log('[teaching] 黑板窗口已重建（恢复当前形态，跳过滑入动画）')
}

/** 确保黑板窗口存在；不存在则创建并停在屏外（滑入动画的起点） */
function ensureBoardWindow(wa: Rect, target: Rect): BrowserWindow {
  if (boardWin && !boardWin.isDestroyed()) return boardWin
  boardReady = false
  const win = createBoardWindow(offscreenRight(wa, target))
  boardWin = win
  return win
}

// ------------------------------------------------------------------ 状态机跃迁（enter / fold / unfold / exit）

/**
 * 查询当前教学模式态（只读；对外归并为 normal/teaching，内部 folded 也属 teaching）。
 * 供其它主进程域使用（气泡域：菜单"开始教学"⇄"结束"文案与动作分支；不改本域任何逻辑）。
 */
export function getTeachingMode(): 'normal' | 'teaching' {
  return mode === 'normal' ? 'normal' : 'teaching'
}

/**
 * 进入教学模式：创建黑板（屏外）→ showInactive → 滑入展开态（260ms）→ 广播 state + podium。
 * 幂等：已展开时忽略（重复触发无害）；折叠态时视为"恢复展开"（用户重喊"开始教学"= 让黑板回来）。
 */
export async function enterTeaching(reason: TeachingEnterReason): Promise<void> {
  if (mode === 'folded') {
    console.log(`[teaching] 已处于教学模式（折叠态），enter(${reason}) 转为恢复展开`)
    await unfoldBoard('enter')
    return
  }
  if (mode === 'expanded') {
    console.log(`[teaching] 已处于教学模式（展开态），忽略 enter(${reason})`)
    return
  }
  const win = petWin
  if (!win || win.isDestroyed()) {
    console.warn('[teaching] 宠物窗口不可用，无法进入教学模式')
    return
  }

  // 记录进入教学前的位置（退出时回位；只取坐标，尺寸用设计常量——见 petHomeRect 注释）。
  // 只在 normal → expanded 跃迁记录：折叠态重复 enter 走上面的 unfoldBoard 分支，
  // 期间宠物可能被用户拖过，但"原位"始终指开课前的那个位置。
  const homeBounds = win.getBounds()
  petHomeRect = {
    x: homeBounds.x,
    y: homeBounds.y,
    width: PET_WINDOW_SIZE.width,
    height: PET_WINDOW_SIZE.height
  }

  const seq = ++opSeq
  mode = 'expanded'
  rebuildCount = 0
  console.log(`[teaching] 进入教学模式（reason=${reason}）`)
  try {
    const wa = petWorkArea()
    const target = currentExpandedBounds(wa)
    // 防御：极端时序下残留的旧黑板先清掉（正常路径此处应为 null）
    if (boardWin && !boardWin.isDestroyed()) destroyBoardWindow()
    const board = ensureBoardWindow(wa, target)
    board.setBounds(offscreenRight(wa, target))
    board.showInactive()
    await animateBoard(target, SLIDE_MS)
    if (seq !== opSeq) return // 滑入期间被 exit 等接管：不广播陈旧状态
    glidePetToPodium(target) // 黑板到位后兔子滑步就位（主进程 relocate；见 glidePetToPodium）
    broadcastState(reason)
  } catch (err) {
    console.error('[teaching] 进入教学模式失败，回退 normal：', err)
    if (seq === opSeq) {
      mode = 'normal'
      destroyBoardWindow()
      // 失败前滑步可能已发出（glide 是 void 异步）：能回就回原位；宠物没动时这是一次原地 relocate
      void returnPetHome()
      broadcastState('enter-failed')
    }
  }
}

/**
 * 折叠（拖动让路）：展开态 → 折叠态。窗口动画到右缘角标 + 黑板收件箱 fold + 广播 folded。
 * 先广播/发指令（渲染侧与窗口动画并行过渡），窗口动画异步执行不阻塞 IPC。
 */
function foldBoardByDrag(): void {
  if (mode !== 'expanded') return
  ++opSeq
  mode = 'folded'
  console.log('[teaching] 宠物拖拽 → 黑板折叠让路')
  sendInbox({ type: 'visibility', action: 'fold' })
  broadcastState('drag')
  void animateBoard(foldedBounds(boardWorkArea()), TRANSITION_MS)
}

/**
 * 恢复展开：折叠态 → 展开态。窗口动画回展开态 + 黑板收件箱 expand + 广播 folded:false + podium。
 * @param reason 'unfold'（角标点击）/ 'enter'（折叠态重复 enter）/ 'goto'（点气泡直达）
 */
function unfoldBoard(reason: string): Promise<void> {
  if (mode !== 'folded') return Promise.resolve()
  ++opSeq // 使此前的 enter/exit 异步收尾失效（本操作已接管黑板）
  mode = 'expanded'
  console.log(`[teaching] 黑板恢复展开（reason=${reason}）`)
  sendInbox({ type: 'visibility', action: 'expand' })
  broadcastState(reason)
  const target = currentExpandedBounds(boardWorkArea())
  void animateBoard(target, TRANSITION_MS)
  glidePetToPodium(target) // 恢复展开：兔子滑步回讲台（主进程 relocate；见 glidePetToPodium）
  return Promise.resolve()
}

/**
 * 退出教学模式（下课）：黑板滑出（260ms）→ 销毁 → **回原位** → 广播 normal。
 * 黑板已不存在（异常路径）时跳过滑出，同样回位后广播——结果语义"一定退出"不可被窗口状态阻塞。
 * 回位完成后再广播：宠物面"面板恢复"与宠物落位同步（与设置窗关闭的回位语义一致，2026-10-17 定稿）。
 */
export async function exitTeaching(reason: string): Promise<void> {
  if (mode === 'normal') {
    // 防御：异常时序残留的黑板窗口（正常 normal 态不存在）——直接静默清掉，不做动画/广播
    if (boardWin) destroyBoardWindow()
    return
  }
  const seq = ++opSeq
  mode = 'normal'
  console.log(`[teaching] 退出教学模式（reason=${reason}）`)
  const board = boardWin
  if (!board || board.isDestroyed()) {
    destroyBoardWindow()
    await returnPetHome()
    if (seq !== opSeq) return // 回位期间被新 enter 接管：不广播陈旧 normal
    broadcastState(reason)
    return
  }
  sendInbox({ type: 'visibility', action: 'exit' })
  await animateBoard(offscreenRight(boardWorkArea(), board.getBounds()), SLIDE_MS)
  // 滑出期间被新 enter 接管：让新操作独占黑板，不做销毁、不回位、不广播陈旧 normal
  if (seq !== opSeq) return
  destroyBoardWindow()
  await returnPetHome()
  if (seq !== opSeq) return // 回位期间被新 enter 接管：新操作已广播 teaching，这里不再发 normal
  broadcastState(reason)
}

/** 跳转到某消息（点击头顶问题气泡）：折叠态先恢复展开，再下发 goto（"卷出并直接跳到该处"） */
async function gotoMessage(messageId: string): Promise<void> {
  if (mode === 'normal') return
  if (mode === 'folded') await unfoldBoard('goto')
  sendInbox({ type: 'goto', messageId })
}

// ------------------------------------------------------------------ IPC 接线（渲染 → 主）

/** 校验进入来源（白名单外退回 'keyword'，仅日志意义）；'bubble' = 说话气泡「展开」（带记录进教学） */
function normalizeEnterReason(reason: unknown): TeachingEnterReason {
  return reason === 'menu' || reason === 'keyword' || reason === 'debug' || reason === 'bubble'
    ? reason
    : 'keyword'
}

/** 注册教学模式 IPC 处理器（main.ts 在 app ready 后调用一次） */
export function initTeaching(pet: BrowserWindow): void {
  petWin = pet
  if (ipcRegistered) return
  ipcRegistered = true

  // ---- 宠物面 / 双端 ----
  ipcMain.on(IPC.TEACHING_ENTER, (event, reason: unknown) => {
    if (!isPetSender(event.sender)) return
    void enterTeaching(normalizeEnterReason(reason))
  })

  // 退出：任一窗来都收（宠物面"下课"关键词 / 黑板面 ×；主进程按 sender 识别来源——契约要求）。
  // 广播 reason 固定 'exit'（契约取值；来源细节只进日志）
  ipcMain.on(IPC.TEACHING_EXIT, (event) => {
    const from = isBoardSender(event.sender) ? 'board' : isPetSender(event.sender) ? 'pet' : 'unknown'
    console.log(`[teaching] 收到退出请求（来源：${from}）`)
    void exitTeaching('exit')
  })

  ipcMain.on(IPC.TEACHING_REPORT_MIRROR, (event, ev: TeachingMirrorEvent) => {
    if (!isPetSender(event.sender)) return
    if (mode === 'normal') return
    if (!ev || typeof ev !== 'object' || typeof ev.kind !== 'string') return
    sendInbox({ type: 'mirror', event: ev })
  })

  ipcMain.on(IPC.TEACHING_GOTO, (event, messageId: string) => {
    if (!isPetSender(event.sender)) return
    if (typeof messageId !== 'string' || messageId.length === 0) return
    void gotoMessage(messageId)
  })

  ipcMain.on(IPC.TEACHING_DRAG_START, (event) => {
    if (!isPetSender(event.sender)) return
    if (mode !== 'expanded') return
    foldBoardByDrag()
  })

  // 黑板左缘拖动改宽（黑板面，2026-10-16 用户定稿）：夹取范围 → 黑板 setBounds（**右缘固定**）
  // → 宠物（展开态在位时）**同帧跟随**（直接 setBounds 跟手，不播动画；渲染侧 geo 自读窗口位置）
  ipcMain.on(IPC.TEACHING_BOARD_RESIZE, (event, width: unknown) => {
    if (!isBoardSender(event.sender)) return
    const w = boardWin
    if (!w || w.isDestroyed() || mode !== 'expanded') return
    const target = typeof width === 'number' && Number.isFinite(width) ? width : 0
    const cur = w.getBounds()
    const right = cur.x + cur.width // 右缘固定（拖动中恒等）
    const wa = petWorkArea()
    const maxW = Math.max(BOARD_MIN_WIDTH, right - wa.x - 10) // 左缘至少留 10px 在工作区内
    const newW = Math.round(Math.min(Math.max(target, BOARD_MIN_WIDTH), maxW))
    if (newW === cur.width) return
    boardWidthOverride = newW // 宽度记忆（下次进教学沿用）
    const next = { x: right - newW, y: cur.y, width: newW, height: cur.height }
    w.setBounds(next)
    const pet = petWin
    if (pet && !pet.isDestroyed() && pet.isVisible()) {
      const p = podiumPoint(next)
      // 尺寸用设计常量（黑板拖动改宽会高频触发；回喂 getBounds 的舍入宽高会让宠物窗
      // 每次 +1px，见 window/index.ts PET_WINDOW_SIZE）
      pet.setBounds({
        x: p.x,
        y: p.y,
        width: PET_WINDOW_SIZE.width,
        height: PET_WINDOW_SIZE.height
      })
    }
  })

  ipcMain.handle(IPC.TEACHING_GET_STATE, () => buildPayload('query'))

  // ---- 黑板面 ----
  ipcMain.on(IPC.TEACHING_READY, (event) => {
    if (!isBoardSender(event.sender)) return
    boardReady = true
    flushPendingInbox()
  })

  ipcMain.on(IPC.TEACHING_REQUEST_UNFOLD, (event) => {
    if (!isBoardSender(event.sender)) return
    void unfoldBoard('unfold')
  })

  ipcMain.on(IPC.TEACHING_REQUEST_SEND, (event, text: string) => {
    if (!isBoardSender(event.sender)) return
    if (typeof text !== 'string' || text.trim().length === 0) return
    // 转发给宠物窗口渲染侧执行既有 WS user_message 发送（黑板自身不连 WS，§7.5.2）
    sendTo(petWin, IPC_EVENTS.TEACHING_SEND_REQUEST, { text })
  })

  console.log('[teaching] IPC 处理器已注册')
}

/** 应用退出清理（will-quit；仿 destroyBallAnimation：退出链路不播动画、不等待，直接销毁黑板窗口） */
export function destroyTeaching(): void {
  ++opSeq
  mode = 'normal'
  rebuildCount = 0
  petHomeRect = null // 退出应用：不做回位动画（宠物窗随后销毁）
  destroyBoardWindow()
  petWin = null
}
