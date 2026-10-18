/**
 * 气泡窗域（用户定稿"气泡系统"）：**独立透明气泡窗** + 标准气泡内容编排。
 *
 * 为什么独立窗口：宠物窗口仅 400×400、兔子占中间，气泡放不下会被窗口裁掉。
 * 故气泡做独立透明小窗（窗口技术照 ball-animation 球窗/自绘托盘菜单先例：transparent + frame:false +
 * alwaysOnTop(screen-saver) + skipTaskbar + Linux type:'toolbar'），**动态尺寸**——渲染侧
 * ResizeObserver 测内容尺寸 → REPORT_SIZE 上报 → 本域 setBounds 调窗（首帧先用预估尺寸定位，
 * 宁大勿小防内容被裁，收到真实尺寸后收紧重定位）。
 *
 * 交互两态：
 *  - 菜单态（interactive=true；右键菜单/清空确认）：窗口可聚焦——弹出时 show+focus（像原生右键菜单）；
 *    点击别处 → blur → 自动收起（标准弹窗行为）；
 *  - 纯展示态（interactive=false；说话气泡）：不聚焦（showInactive）+ 鼠标穿透
 *    （setIgnoreMouseEvents(true)），不注册 blur 收起。说话气泡虽属"纯展示"，但其上的
 *    悬浮工具条要能点到，故显示时接鼠标、再由窗口形状把**非气泡区域**放开（见 applyBubbleShape）。
 *
 * 定位（防出屏）：锚点 = 宠物窗位置 + 兔子头部固定偏移（HEAD_ANCHOR_OFFSET）；摆放纯函数见
 * geometry.ts（优先后上 tail=down，放不下翻向 tail=up，横向夹进工作区）。尺寸上报引发翻向
 * 变化时经 SET_TAIL 轻量下发（仅换样式，不重播动画）。
 *
 * 动画分工（照 IPC_BALL_ANIMATION 先例：主进程是指挥、渲染页负责"画"）：入场动画在气泡窗内播
 * （当前菜单/确认/说话气泡统一"轻量展开"弹性绽放；"手来手回"预设保留但不再用于菜单——
 * 2026-10-17 用户反馈光点 + 延迟弹出像"分两段"；退场同款反向）；收起 = 本域先发
 * REQUEST_CLOSE → 渲染侧播退场动画 → CLOSED 回报 → 本域 hide（渲染异常时 CLOSE_TIMEOUT_MS
 * 超时兜底强制 hide）。
 *
 * 说话气泡（场景3，2026-10-16 落地/当日二轮定稿"不消失+可展开"）：聊天回复展示在兔子头部旁——
 * 宠物面（chat 域）经 SAY_BEGIN/SAY_TEXT/SAY_END 驱动：出现（流式文本经 UPDATE 同 session 刷新，
 * 气泡贴锚点向上生长）→ **常驻**（用户定稿：回复结束不自动收，看完由用户处理）。交互：
 *  - 悬浮（鼠标移上气泡）→ 气泡上方浮出工具条「⤢ 展开｜✕」（渲染侧 hover + ACTION 回传）；
 *  - ✕（action 'close'）→ 收掉当前消息（清文本，菜单后续关闭不复活）；
 *  - 展开（action 'expand'）→ **带聊天记录进入教学**（enterTeaching('bubble')；黑板滑出+兔子讲台位，
 *    记录预填由宠物面在 state.reason==='bubble' 时自行 seed——经既有镜像通道）；
 *  - 被打断（immediate）立即收；新回复到来原地替换（同窗复用不重播入场）。
 * 悬浮交互需要气泡窗"接鼠标"：用窗口形状（REPORT_SHAPE 上报 → win.setShape 裁到"气泡+条区"，
 * 其余透明区域保持完全穿透——宠物窗"空气让路"同款机制）。**Windows 同样走这条**：setShape 的
 * 官方平台标注就是 win32+linux（原先只在 Linux 调用，导致 Windows 上整窗可交互——气泡常驻期间
 * 那块 370×218 的透明留白会把桌面点击全吃掉）。
 * 宠物移动（走动/拖拽）时气泡跟随重摆（petWin 'move' + 16ms 节流，不播动画）；不跟随仅限菜单态。
 * 与菜单互斥：弹菜单前说话气泡先硬收（同窗不能同时服务两种内容）；**菜单关闭后自动恢复**
 * （内容不丢——"不消失"闭环）；菜单里点了教学/展开/设置/隐藏则在 menuSuppressRestore 标记下不恢复。
 * 教学/向导态抑制在聊天域（宠物面不推）——本域不感知业务。
 *
 * 动作分发（气泡窗 → ACTION → 本域执行）：教学 enter/exit（按 teaching 域当前态二选一）、
 * 打开设置 openSettings、隐藏 runHideAnimation、"清空聊天"先换确认气泡（不关窗）、
 * 确认后向宠物窗发 CHAT_CLEAR_REQUESTED（清空逻辑归后续任务）；说话气泡 expand/close 见上。
 * 动作白名单按当前内容校验。
 *
 * 生命周期：懒创建。**Windows 隐藏复用**（避免每次右键菜单新建渲染进程——dev 实测约 300ms
 * 延迟）；**Linux/macOS 隐藏即销毁、下次唯一 partition 重建**（"hide → 隐藏态 resize → show"
 * 路径的 KWin/Chromium 残屏缺陷规避，排查全程见 destroyBubbleWindow 注释）；退出（will-quit）destroy。
 * 策略出口：platform.REUSE_BUBBLE_WINDOW（bubble 域不直接读 process.platform）。
 */
import {
  app,
  BrowserWindow,
  clipboard,
  ipcMain,
  Menu,
  screen,
  type WebContents
} from 'electron'
import { join } from 'node:path'
import { isWindows, linuxOnlyWindowOptions, REUSE_BUBBLE_WINDOW } from '../platform'
import {
  IPC,
  IPC_BUBBLE,
  IPC_EVENTS,
  type BubbleMenuItemPayload,
  type BubbleOpenPayload,
  type BubbleRequest,
  type BubbleSayBeginPayload,
  type BubbleSayEndPayload,
  type BubbleSayTextPayload,
  type BubbleSpeechEventPayload,
  type BubbleSpeechMeta,
  type BubbleTail,
  type BubbleUpdatePayload
} from '../ipc/channels'
import { runHideAnimation } from '../ball-animation'
import { openSettings } from '../settings'
import { enterTeaching, exitTeaching, getTeachingMode } from '../teaching'
import { openWork } from '../work'
import { computeBubblePlacement, followSize } from './geometry'
import type { Point, Rect, Size } from '../window'

const isDev = !app.isPackaged

/**
 * 兔子头部锚点偏移（宠物窗内坐标）：气泡从兔子头右上方展开、尾巴朝左下指向兔子头——
 * 窗口 400×400、兔子视觉范围约 x 65–335 / y 8–348，锚点取右侧头肩一带。
 * 右键菜单与说话气泡共用（用户定稿"像右键兔子的头部一样"）；改宠物形象/窗口尺寸时同步调整。
 */
const HEAD_ANCHOR_OFFSET: Point = { x: 255, y: 92 }

/**
 * 各形态预估尺寸（px；show 前先用它定位——真实尺寸经 REPORT_SIZE 收紧重定位）。
 * 与渲染侧 bubble.css 的内容尺寸大致对齐（宁大勿小：大了透明区稍多，小了内容被裁）。
 * 高度含顶部悬浮条区 28（PAD.top=40——说话气泡悬浮工具条占位；菜单/确认同布局，见 geometry.ts）。
 */
const ESTIMATED_SIZE: Record<'menu' | 'confirm' | 'text', Size> = {
  // 与实际菜单一致（实测 215×206）：首帧 show 后不再因"预估高度 228 → 实际 206"缩一下，
  // 避免弹出过程出现尺寸跳变（用户反馈菜单"分两段"的另一来源）
  menu: { width: 216, height: 206 },
  confirm: { width: 236, height: 178 },
  text: { width: 370, height: 218 }
}

/** 宠物移动跟随节流（ms）：拖动/走动时 petWin 'move' 高频触发，至多每 16ms 重摆一次气泡窗 */
const FOLLOW_THROTTLE_MS = 16

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
const MENU_ACTION_IDS: readonly string[] = [
  'teaching',
  'work',
  'settings',
  'clear-chat',
  'hide-pet'
]
/** 确认气泡动作 id 白名单（PetBubble 组件的通用语义 id：确认/取消） */
const CONFIRM_ACTION_IDS: readonly string[] = ['confirm', 'cancel']
/** 说话气泡动作 id 白名单（悬浮工具条：expand=带记录进教学；close=收气泡；reminder-ack=提醒已读） */
const SPEECH_ACTION_IDS: readonly string[] = ['expand', 'close', 'reminder-ack']

/** 清空确认文案（用户定稿场景2；确认动作本期只发事件，清空逻辑归后续任务） */
const CLEAR_CHAT_CONFIRM = {
  message: '清空全部聊天记录？',
  confirmLabel: '清空',
  cancelLabel: '取消'
} as const

// ------------------------------------------------------------------ 模块级状态（本域单例）

/** 宠物窗口（initBubble 注入；锚点计算/请求清空路由/隐藏动作的对象） */
let petWin: BrowserWindow | null = null
/** 气泡窗（懒创建；隐藏收尾即销毁——每次弹出重建，缘由见 destroyBubbleWindow） */
let bubbleWin: BrowserWindow | null = null
/** 气泡页已就绪标志（收到 READY 置位；窗口重建后复位） */
let bubbleReady = false
/** 等待就绪的回调队列（气泡页就绪时统一唤醒） */
let readyWaiters: Array<() => void> = []
/** ipcMain 监听是否已注册（只能注册一次，重复注册会叠加处理器） */
let ipcRegistered = false
/** 弹出流程防重入（等待页面就绪是异步的：防右键连点并发建窗/重复下发） */
let opening = false
/**
 * 当前待确认动作（2026-10-18 泛化）：确认气泡不再只服务"清空聊天"。
 * - ``onConfirm``：用户点「确认」后执行的动作（清空聊天 / 删除文件的 IPC 回调等）；
 * - ``resolve``：把"确认/取消/超时/点别处"的结果交还给请求方（invoke 的 Promise）；
 * - ``timer``：长时间无操作按取消处理，避免调用方永久挂起。
 */
interface PendingConfirm {
  onConfirm: () => void | Promise<void>
  resolve: (confirmed: boolean) => void
  timer: NodeJS.Timeout | null
}
let pendingConfirm: PendingConfirm | null = null
/** 确认气泡无人操作自动取消的时长（ms） */
const CONFIRM_TIMEOUT_MS = 120_000

/** 确认气泡请求（主进程内部 IPC 用；onConfirm 可为空——删除文件由 IPC 处理器执行） */
export interface ConfirmRequest {
  message: string
  confirmLabel?: string
  cancelLabel?: string
  onConfirm?: () => void | Promise<void>
}
/** 收起流程中（已发 REQUEST_CLOSE、等待渲染侧退场回报或超时兜底） */
let closing = false
/** 退场回报超时定时器 */
let closeTimer: NodeJS.Timeout | null = null
/** 弹出会话序号（每次 OPEN 递增；渲染侧按 session 去重——补发同载荷不重播动画） */
let sessionSeq = 0
/**
 * 气泡窗创建序号（每次 createBubbleWindow 递增；作 partition 后缀——见 createBubbleWindow 的
 * "为何每次新 partition"说明。进程级状态（渲染进程复用坏状态）是 v1"销毁重建"失效的根因）。
 */
let windowSeq = 0
/** 当前内容载荷（动作白名单校验 / 补发 / tail 更新用） */
let currentPayload: BubbleOpenPayload | null = null
/** 当前锚点（屏幕坐标；宠物移动时由跟随逻辑重算） */
let anchor: Point | null = null
/**
 * 最近一次已知内容尺寸（DIP，含窗内留白）——follow 重摆**只允许用它**，不得读 win.getBounds()：
 * Windows（175% 缩放实测）上 getBounds 会把 fractional DPI 舍入结果回吐（set 175x89 → get 176x90），
 * 把它再喂回 setBounds 会每次 +1px 累积增长。宠物走动/拖拽时跟随以 60fps 触发，窗口很快撑大——
 * 气泡（bottom 锚定）随窗口变高下沉、窗口形状却停在旧位置，最终整条消息被形状裁掉（用户反馈
 * "一动宠物消息就消失"的根因）。内容尺寸只由渲染侧 REPORT_SIZE 更新（播放稳定、无反馈环）。
 */
let contentSize: Size | null = null
/**
 * 最近一次实际下发的窗口 bounds（请求值，不是 getBounds 舍入后的值）——相同则跳过 setBounds：
 * ① 避免跟随/尺寸上报的高频重复调用；② 防止"渲染侧 resize 事件 → REPORT_SIZE → setBounds →
 * 再触发 resize"的潜在闭环。
 */
let lastAppliedBounds: Rect | null = null
/** 当前尾巴朝向（尺寸上报引发翻向时与 lastTail 比较后才下发 SET_TAIL） */
let lastTail: BubbleTail = 'down'
/** 当前是否交互态（菜单/确认态 true；说话气泡纯展示态 false——穿透+不聚焦+不注册 blur 收起） */
let interactive = true

// ---- 说话气泡状态（场景3：宠物面驱动的一次"说话"会话） ----
/** 说话会话活跃中（SAY_BEGIN 置位、SAY_END 复位）——TEXT/END 只在活跃期生效（菜单吞掉的轮次自然跳过） */
let speechActive = false
/** 会话作废（弹出期被打断/让位）——openSpeechBubble 的异步就绪等待回来后据此中止弹出 */
let speechCancelled = false
/** 菜单让位不恢复标记（菜单里点了教学/展开/设置/隐藏 → 菜单关闭后不恢复气泡；普通关闭则恢复） */
let suppressSpeechRestore = false
/** 最新文本快照（渲染侧全文覆盖式；begin 异步就绪期间到达的文本在此暂存，就绪后补发；常驻期间为"当前显示内容"） */
let speechText = ''
/**
 * 本轮说话的消息属性（2026-10-18）：普通回复 / 提醒。
 * 提醒气泡由气泡窗显示「知道了」；关闭时向宠物窗回传未读列表生命周期事件。
 */
let speechMeta: BubbleSpeechMeta | null = null
/** 回复气泡空闲自动收起时长（ms；0=不自动收）——设置保存后经 SET_IDLE_TTL 下发 */
let speechIdleMs = 30_000
/** 本轮回复是否已进入"可自动收起"阶段（SAY_END(false) 后置位；新一轮 SAY_BEGIN 清除；菜单让位保留） */
let speechIdleEligible = false
/** 悬浮/选中文字期间暂停计时（气泡渲染侧上报） */
let speechIdlePaused = false
/** 空闲收起定时器（关闭/让位/新回复/交互时清理） */
let speechIdleTimer: NodeJS.Timeout | null = null
/** 本轮说话的空闲时长覆盖（本地短提示 5s；普通回复为 null → 用设置值） */
let speechIdleOverrideMs: number | null = null
/** 下一次 SAY_BEGIN 使用的临时空闲时长（由 SET_NEXT_SPEECH_TTL 预置，BEGIN 消费一次） */
let pendingSpeechTtlMs: number | null = null
/** 说话气泡右键菜单打开中：原生菜单可能让窗失焦，blur 守卫必须放行 */
let speechContextMenuOpen = false
/** Windows 光标悬浮轮询（气泡在宠物窗下层时渲染侧收不到 pointerenter，主进程兜底） */
let speechHoverPoll: NodeJS.Timeout | null = null
let speechHoverInside = false
/** 宠物移动跟随节流标志（move 事件高频；至多每 FOLLOW_THROTTLE_MS 重摆一次） */
let followPending = false
/** 气泡窗交互形状（渲染侧 REPORT_SHAPE 上报；Linux 用 win.setShape 裁输入区——说话气泡悬浮交互 + 其余穿透） */
let shapeRects: Rect[] = []
/** Windows 复用策略的预热定时器（will-quit 清理，避免退出过程中又建窗） */
let warmTimer: NodeJS.Timeout | null = null

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

/** 两条消息属性是否同一批（重复 SAY_BEGIN 幂等用） */
function sameSpeechMeta(a: BubbleSpeechMeta | null, b: BubbleSpeechMeta | null): boolean {
  if (a === null || b === null) return a === b
  return a.kind === b.kind && a.batchId === b.batchId && a.messageId === b.messageId
}

/**
 * 向宠物窗回传提醒气泡的生命周期：
 *  - closed：气泡关闭（自动收起 / ✕ / 被新消息替换 / 教学向导让位）→ 未读进列表；
 *  - reminder-ack：用户点了「知道了」→ 宠物面发 ack_reminders，清单移除。
 * 非提醒气泡（普通回复）不产生事件。
 */
function notifySpeechEvent(type: 'closed' | 'reminder-ack', reason?: string): void {
  const meta = speechMeta
  if (!meta || meta.kind !== 'reminder') return
  const pet = petWin
  if (!pet || pet.isDestroyed() || pet.webContents.isDestroyed()) return
  const payload: BubbleSpeechEventPayload = { type, meta, reason }
  try {
    pet.webContents.send(IPC_EVENTS.BUBBLE_SPEECH_EVENT, payload)
    console.log(`[bubble] 提醒气泡事件：${type}${reason ? `（${reason}）` : ''}`)
  } catch (err) {
    console.warn('[bubble] 回传提醒气泡事件失败（忽略）：', err)
  }
}

/** REQUEST_OPEN 载荷校验（本期只有 { kind:'menu' }） */
function isMenuRequest(request: unknown): request is BubbleRequest {
  return Boolean(request && typeof request === 'object' && (request as BubbleRequest).kind === 'menu')
}

/** 数值夹取 */
function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi)
}

/** 当前窗是否在显示菜单/确认内容（交互态）——弹出前硬收说话气泡、说话请求忽略都据它判断 */
function isMenuShowing(): boolean {
  return Boolean(
    bubbleWin &&
      !bubbleWin.isDestroyed() &&
      bubbleWin.isVisible() &&
      !closing &&
      currentPayload?.variant !== 'text'
  )
}

/** 当前窗是否在显示说话气泡（纯展示态）——宠物移动跟随、菜单让位判断用 */
function isSpeechShowing(): boolean {
  return Boolean(
    bubbleWin &&
      !bubbleWin.isDestroyed() &&
      bubbleWin.isVisible() &&
      !closing &&
      currentPayload?.variant === 'text'
  )
}

// ---- 回复气泡空闲自动收起（设置：pet.bubble_idle_seconds） ----

function clearSpeechIdleTimer(): void {
  if (speechIdleTimer !== null) {
    clearTimeout(speechIdleTimer)
    speechIdleTimer = null
  }
}

/**
 * 启动空闲收起计时（幂等：先清旧计时）。
 * 仅在"回复已结束（eligible）+ 文本还在 + 气泡正在显示 + 未暂停 + 时长>0"时启动；
 * 菜单让位/教学/向导/气泡关闭时条件不满足，自然不计时。
 */
function scheduleSpeechIdleDismiss(): void {
  clearSpeechIdleTimer()
  const idleMs = speechIdleOverrideMs ?? speechIdleMs
  if (
    !speechIdleEligible ||
    speechIdlePaused ||
    speechHoverInside ||
    speechContextMenuOpen ||
    idleMs <= 0
  ) {
    return
  }
  if (!speechText || !isSpeechShowing() || isMenuShowing()) return
  if (getTeachingMode() === 'teaching') return
  speechIdleTimer = setTimeout(() => {
    speechIdleTimer = null
    if (!speechIdleEligible || speechIdlePaused || speechHoverInside) return
    if (!speechText || !isSpeechShowing()) return
    console.log(`[bubble] 空闲 ${idleMs}ms，自动收起说话气泡`)
    stopSpeech('空闲自动收起', false)
  }, idleMs)
  speechIdleTimer.unref?.()
}

function stopSpeechHoverPoll(): void {
  if (speechHoverPoll !== null) {
    clearInterval(speechHoverPoll)
    speechHoverPoll = null
  }
  speechHoverInside = false
}

/**
 * Windows 兜底：气泡在宠物窗下层时，渲染侧收不到 pointerenter（悬浮不暂停）。
 * 主进程轮询光标是否在气泡窗内——进入即清零并停表，移出后重新计满。
 * 非 Windows 不轮询（X11 的 getCursorScreenPoint 会冻结；渲染侧事件足够）。
 */
function startSpeechHoverPoll(): void {
  if (!isWindows || speechHoverPoll !== null) return
  speechHoverPoll = setInterval(() => {
    if (!isSpeechShowing()) {
      stopSpeechHoverPoll()
      return
    }
    const inside = pointInsideBubble(screen.getCursorScreenPoint())
    if (inside === speechHoverInside) return
    speechHoverInside = inside
    if (inside) {
      clearSpeechIdleTimer()
    } else if (speechIdleEligible) {
      scheduleSpeechIdleDismiss()
    }
  }, 200)
  speechHoverPoll.unref?.()
}

/**
 * 说话气泡右键复制菜单（由渲染侧 contextmenu 主动请求——比 webContents 的
 * 原生 context-menu 事件可控：能阻止事件继续派发，避免右键穿透到宠物窗把气泡让位）。
 * 复制动作只写剪贴板，**不收起气泡**；收起是独立的菜单项。
 */
function showSpeechContextMenu(selectionText: string): void {
  if (speechContextMenuOpen) return // 已有复制菜单：忽略重复请求（双窗口都收到右键的情况）
  if (!isSpeechShowing() || currentPayload?.variant !== 'text' || !speechText) return
  const selected = selectionText.replace(/\r\n/g, '\n')
  const template: Electron.MenuItemConstructorOptions[] = []
  if (selected.trim()) {
    template.push({
      label: '复制选中内容',
      click: () => clipboard.writeText(selected)
    })
  }
  template.push({
    label: '复制整条消息',
    click: () => clipboard.writeText(speechText)
  })
  template.push({ type: 'separator' })
  template.push({
    label: '收起气泡',
    click: () => stopSpeech('右键收起', false)
  })
  console.log(`[bubble] 右键菜单（选中 ${selected.length} 字）`)
  const win = bubbleWin
  // 菜单期间：不清空文本、不计空闲收起、blur 守卫放行
  interactive = false
  speechContextMenuOpen = true
  clearSpeechIdleTimer()
  const onClosed = (): void => {
    speechContextMenuOpen = false
    if (speechIdleEligible) scheduleSpeechIdleDismiss()
  }
  try {
    Menu.buildFromTemplate(template).popup(
      win && !win.isDestroyed() ? { window: win, callback: onClosed } : { callback: onClosed }
    )
  } catch {
    onClosed()
  }
}

/** 点是否在当前说话气泡窗内（右键落到宠物窗时的兜底判定） */
function pointInsideBubble(point: Point): boolean {
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

/**
 * 应用渲染侧上报的交互形状（setShape：输入区 = 上报矩形，形状外完全穿透）。
 *
 * **Windows 同样走这条**（2026-10-16 移植修正）：`setShape` 在 Electron 的官方平台标注是
 * `@platform win32,linux`（见 electron.d.ts 的 BrowserWindow.setShape），原先只在 Linux 调用，
 * 导致 Windows 上说话气泡（370×218 的窗口，其中大部分是透明留白）**整窗接鼠标**——
 * 气泡常驻期间这块透明区会把桌面点击全吃掉。两平台统一用形状方案即可。
 * 未收到上报（旧渲染/浏览器调试）时保持全窗默认——菜单等场景无损。
 */
function applyBubbleShape(): void {
  const win = bubbleWin
  if (!win || win.isDestroyed() || shapeRects.length === 0) return
  try {
    win.setShape(shapeRects)
  } catch (err) {
    console.warn('[bubble] setShape 失败（忽略）：', err)
  }
}

/**
 * show 后延迟补发当前内容（ms）：did-finish-load 早于 React 订阅建立时首帧可能丢失的兜底。
 * 幂等安全：同 session 载荷渲染侧只认不重播；补发前重读 currentPayload——期间换成新内容则补发新内容（无害）。
 */
function scheduleOpenRepost(win: BrowserWindow): void {
  setTimeout(() => {
    if (bubbleWin === win && win.isVisible() && !closing && currentPayload) {
      sendTo(win, IPC_BUBBLE.OPEN, currentPayload)
    }
  }, OPEN_REPOST_MS)
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

/** 创建气泡窗（窗口技术照 ball-animation 球窗/自绘托盘菜单先例；见文件头"交互两态"） */
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
    // （选项按平台从 electron/platform 取，非 Linux 为空对象）
    ...linuxOnlyWindowOptions(),
    show: false,
    webPreferences: {
      /**
       * **每次唯一 partition（`bubble-序号`；Linux/macOS）** —— 强制"独立 storage session" ⇒
       * Chromium 必然分配**全新渲染进程**（不同 SiteInstance 不可同进程）。
       * Windows 不复用这条策略：窗口隐藏后复用，partition 固定为 `bubble`（见 destroyBubbleWindow）。
       *
       * 为什么（2026-10-16 真机排查的最终根因）：**坏状态存在于渲染进程内部**（合成器/surface
       * 缓存——复用窗口路径 hide→隐藏态 resize→show 之后"画面残缺"：窗口/布局/上报全对，画出来
       * 只有左上角一块且带旧阴影残留 = 渲染进程内的部分重绘残留）。进程监视实证：**销毁窗口 +
       * 重建期间，气泡窗渲染进程 pid 全程不变**（Electron 复用进程）——所以 v1"隐藏即销毁、
       * 下次重建"**无效**（新窗口沿用带病进程）；而"应用刚启动后的第一颗气泡永远正常"正是
       * "全新进程 = 干净"的两次独立印证。每次新 partition ⇒ 每次弹出都是"第一颗"。
       *
       * 附：内存 session（无 `persist:` 前缀）不落盘，随窗口销毁回收；气泡页无持久化需求，
       * 无副作用（仅每次弹出多一次页面加载/进程启动开销——与首弹同量级，实测可接受）。
       */
      // Windows：隐藏复用同一个窗口，partition 固定即可（不再每次新建渲染进程）；
      // Linux/macOS：每次唯一 partition（KWin 残屏规避，见上方完整排查）
      partition: REUSE_BUBBLE_WINDOW ? 'bubble' : `bubble-${++windowSeq}`,
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
    if (speechContextMenuOpen || !interactive) return
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

/** 取（必要时创建）气泡窗——隐藏收尾已销毁，故正常路径下这里基本总是新建（见 destroyBubbleWindow） */
function ensureBubbleWindow(): BrowserWindow {
  if (bubbleWin && !bubbleWin.isDestroyed()) return bubbleWin
  bubbleReady = false
  // 新窗口没有"上次下发值"与内容尺寸：跟随/尺寸上报必须重新完整下发一次
  contentSize = null
  lastAppliedBounds = null
  bubbleWin = createBubbleWindow()
  return bubbleWin
}

/** 等待气泡页就绪（带超时；照 ball-animation/tray 域 waitReady 模式） */
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
  settleConfirm(false)
  if (warmTimer) {
    clearTimeout(warmTimer)
    warmTimer = null
  }
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
  contentSize = null
  lastAppliedBounds = null
  interactive = true
  speechActive = false
  speechCancelled = false
  suppressSpeechRestore = false
  speechText = ''
  speechMeta = null
  speechIdleMs = 30_000
  speechIdleEligible = false
  speechIdlePaused = false
  speechIdleOverrideMs = null
  pendingSpeechTtlMs = null
  clearSpeechIdleTimer()
  stopSpeechHoverPoll()
  shapeRects = []
  if (win && !win.isDestroyed()) win.destroy()
}

/**
 * 收尾当前气泡窗（隐藏收尾时调用）：
 *  - **Windows（REUSE_BUBBLE_WINDOW=true）**：只 hide、保留窗口与渲染进程（下次 show 秒开；
 *    每次右键菜单销毁重建渲染进程在 dev 下实测约 300ms 延迟）；
 *  - **Linux/macOS**：销毁，下次经 ensureBubbleWindow 重建——**与 createBubbleWindow 的
 *    "每次唯一 partition"配套，两者缺一不可**（partition 在建窗时固定，不销毁重建就无法换进程）。
 *
 * **Linux 为什么不复用窗口**（2026-10-16 真机排查全程）：复用路径（hide → 隐藏态 setBounds → show）
 * 在真机上画面必然残缺——窗口几何/消息/布局/尺寸上报全部正确，但"画出来"只有内容左上角一块
 * （右侧 62px 硬切、顶部缺 8px，且顶部阴影仍有残留 = 部分重绘残留而非矩形裁剪）。
 * 已排查排除：`webContents.invalidate()` 无效；外部真实 resize（X 层面 370→440→370 确认生效）
 * 画面纹丝不动；**v1"仅销毁重建"亦无效**——进程监视实证"销毁窗口期间渲染进程 pid 不变"
 * （坏状态在渲染进程内部，被新窗口继承）。**根治 = 每次唯一 partition（见 createBubbleWindow）
 * ⇒ 每次全新渲染进程**；本函数负责"每次销毁重建"，是根治方案的必要一环。
 */
function destroyBubbleWindow(reason: string): void {
  clearSpeechIdleTimer()
  stopSpeechHoverPoll()
  const win = bubbleWin
  shapeRects = [] // 旧形状不得套用到下一份内容（渲染侧会重新上报）
  contentSize = null
  lastAppliedBounds = null

  if (!win || win.isDestroyed()) {
    bubbleWin = null
    bubbleReady = false
    return
  }

  // Windows：隐藏复用（2026-10-17）。每次右键菜单销毁再重建渲染进程，dev 下实测要等约
  // 300ms（生产构建首次约 170ms）——菜单弹出明显滞后。复用后第二次起只需 show + 下发内容。
  if (REUSE_BUBBLE_WINDOW) {
    if (win.isVisible()) win.hide()
    // 旧 region 是上一份内容的裁剪区，新内容尺寸/位置可能不同：先恢复整窗，等渲染侧
    // REPORT_SHAPE 再收紧（窗口隐藏期间无输入影响；show 后一两帧透明区短暂可点，可接受）
    try {
      const b = win.getBounds()
      win.setShape([{ x: 0, y: 0, width: b.width, height: b.height }])
    } catch (err) {
      console.warn('[bubble] 隐藏复用前重置窗口形状失败（忽略）：', err)
    }
    console.log(`[bubble] 气泡窗已隐藏复用（${reason}）`)
    return
  }

  // Linux/macOS：隐藏即销毁 + 每次唯一 partition 重建（KWin 残屏根治方案的必要一环）
  // 先清模块级引用再 destroy：'closed' 事件处理器据 bubbleWin===win 判重，引用已易主则不重复清
  bubbleWin = null
  bubbleReady = false
  win.destroy()
  console.log(`[bubble] 气泡窗已销毁（${reason}）——下次弹出重建`)
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
 * 强制气泡窗渲染进程全量重绘（轻量兜底，**非根治**）。
 *
 * 背景（2026-10-16 真机排查全程）：症状为"隐藏 → 再显示 + 尺寸跳变"（右键菜单让位恢复 / 教学
 * 进出等复用流程）后画面残缺——窗口/布局/尺寸上报全部正确，但气泡"画出来"只有左上角一块
 * （右侧 62px 硬切、顶部缺 8px，行尾文字被切；重启后第一颗气泡完好、复用必坏；Playwright
 * 虚拟层复现不出——真机 KWin/Chromium 特有）。曾据此用 invalidate() 强制重绘，**真机复现
 * 证明无效**（外部真实 resize 到 440 宽画面同样纹丝不动）；**根治手段 = 每次弹出重建窗口**，
 * 见 destroyBubbleWindow 的完整排查记录。本函数保留为代价极低的兜底（对"显示后绘制轻微
 * 未同步"或有助益，无害）。
 */
function forceRepaint(win: BrowserWindow): void {
  if (win.isDestroyed() || win.webContents.isDestroyed()) return
  try {
    win.webContents.invalidate()
  } catch (err) {
    console.warn('[bubble] 强制重绘失败（忽略）：', err)
  }
}

/**
 * 按锚点摆放气泡窗（geometry 纯函数 + 所在显示器工作区）——**所有 setBounds 的统一收口**：
 * 末尾强制一次全量重绘（见 forceRepaint：防"文本绘制层不跟尺寸"的真机渲染 bug）。
 * @returns 摆放决策出的尾巴朝向（调用方负责与 lastTail 比较、必要时下发 SET_TAIL）
 */
function applyPlacement(win: BrowserWindow, size: Size): BubbleTail {
  const a = anchor
  if (!a) return 'down'
  const width = Math.round(clamp(size.width, MIN_SIZE.width, MAX_SIZE.width))
  const height = Math.round(clamp(size.height, MIN_SIZE.height, MAX_SIZE.height))
  contentSize = { width, height } // 跟随重摆的唯一尺寸来源（见 contentSize 注释）
  const wa = screen.getDisplayNearestPoint({ x: Math.round(a.x), y: Math.round(a.y) }).workArea
  const p = computeBubblePlacement(a, { width, height }, wa)
  const next: Rect = { x: p.x, y: p.y, width, height }
  // 请求值相同则跳过：避免高频重复 setBounds（跟随/尺寸上报），也切断 resize → REPORT_SIZE 闭环
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
    forceRepaint(win)
  }
  return p.tail
}

// ------------------------------------------------------------------ 弹出 / 收起

/** 组装菜单载荷（"开始教学" ⇄ "结束"由 teaching 域当前态决定；彩色图标名见 src/shared/icons） */
function buildMenuPayload(): BubbleOpenPayload {
  const teaching = getTeachingMode() === 'teaching'
  const items: BubbleMenuItemPayload[] = [
    { id: 'teaching', label: teaching ? '结束' : '开始教学', icon: 'teaching' },
    { id: 'work', label: '工作模式', icon: 'work' },
    { id: 'settings', label: '打开设置', icon: 'settings' },
    { id: 'clear-chat', label: '清空聊天', icon: 'broom' },
    { id: 'hide-pet', label: '隐藏', icon: 'sleep' }
  ]
  return {
    session: ++sessionSeq,
    variant: 'menu',
    tail: 'down',
    // 2026-10-17 用户反馈：手来手回的"光点飞行 130ms + 气泡延迟弹出"看起来像分两段。
    // 菜单改用轻量展开（自尾巴处直接弹出，220ms），单段、跟手；确认气泡同理。
    motion: { enter: 'light', exit: 'light' },
    stableWindow: REUSE_BUBBLE_WINDOW,
    items
  }
}

/** 组装确认载荷（2026-10-18 泛化：清空聊天 / 删除本机文件共用） */
function buildConfirmPayload(request: ConfirmRequest): BubbleOpenPayload {
  return {
    session: ++sessionSeq,
    variant: 'confirm',
    tail: 'down',
    motion: { enter: 'light', exit: 'light' },
    stableWindow: REUSE_BUBBLE_WINDOW,
    message: request.message,
    confirmLabel: request.confirmLabel ?? '确定',
    cancelLabel: request.cancelLabel ?? '取消'
  }
}

/**
 * 组装说话气泡载荷（场景3）：纯展示态；"轻量展开"动画（气泡自尾巴处弹性绽放/收拢，
 * 不飞光点——说话高频，每句都飞光点会闹；菜单/确认现也统一用本预设）。
 * message 初始可为空串（reply_start 时）——文本随后经 UPDATE 流式刷新。
 */
function buildSpeechPayload(
  message: string,
  meta: BubbleSpeechMeta | null = null
): BubbleOpenPayload {
  return {
    session: ++sessionSeq,
    variant: 'text',
    tail: 'down',
    motion: { enter: 'light', exit: 'light' },
    stableWindow: REUSE_BUBBLE_WINDOW,
    message,
    meta: meta ?? undefined
  }
}

/**
 * 按尺寸重摆气泡窗 + 翻向变化时轻量下发 SET_TAIL（不重播动画）——尺寸上报重定位与
 * 说话气泡跟随重摆共用（两者都需要同步 lastTail/currentPayload）。
 */
function reposition(win: BrowserWindow, size: Size): void {
  const tail = applyPlacement(win, size)
  if (tail !== lastTail) {
    lastTail = tail
    sendTo(win, IPC_BUBBLE.SET_TAIL, tail)
  }
  if (currentPayload) currentPayload = { ...currentPayload, tail }
}

/** 结清当前待确认动作：把结果交还请求方并清掉定时器（幂等）。 */
function settleConfirm(confirmed: boolean): void {
  const pending = pendingConfirm
  if (!pending) return
  pendingConfirm = null
  if (pending.timer) clearTimeout(pending.timer)
  try {
    pending.resolve(confirmed)
  } catch (err) {
    console.warn('[bubble] 确认结果回传失败（忽略）：', err)
  }
}

/**
 * 气泡收尾（真实隐藏）：清超时定时器 + closing 复位 + hide + **销毁窗口**（不复用——见
 * destroyBubbleWindow）。
 * 供三处调用：渲染侧 CLOSED 回报、超时兜底、弹出前"半收状态"收尾（右键抢焦点触发 blur 的场景）。
 * 销毁后尝试恢复说话气泡（菜单关闭 → 内容还在的那条回来——走 ensureBubbleWindow 新建；
 * 见 maybeRestoreSpeech 的守卫）。
 */
function finishClose(reason: string): void {
  // 确认气泡被关闭（取消/点别处/退场回报）：把 false 交还给请求方
  settleConfirm(false)
  clearSpeechIdleTimer()
  stopSpeechHoverPoll()
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
  destroyBubbleWindow(`收尾：${reason}`)
  maybeRestoreSpeech()
}

/** 请求收起（blur / 动作执行后）：先让渲染侧播退场动画（按载荷 motion，当前轻量收拢），CLOSED 回报后 hide；超时兜底 */
function closeBubble(reason: string): void {
  const win = bubbleWin
  if (!win || win.isDestroyed() || !win.isVisible() || closing) return
  clearSpeechIdleTimer()
  stopSpeechHoverPoll()
  closing = true
  console.log(`[bubble] 收起气泡（${reason}）——等待渲染侧退场动画回报`)
  sendTo(win, IPC_BUBBLE.REQUEST_CLOSE)
  closeTimer = setTimeout(() => {
    console.warn('[bubble] 退场动画回报超时，强制隐藏收尾')
    finishClose('超时兜底')
  }, CLOSE_TIMEOUT_MS)
}

// ------------------------------------------------------------------ 说话气泡（场景3：聊天回复展示在兔子头部旁）

/**
 * 收起说话气泡。
 *  - 气泡已显示：hard=true 立即隐藏收尾（菜单让位/展开进教学——同窗要立刻腾场，不能等退场动画）；
 *    hard=false 播轻量退场（REQUEST_CLOSE → 渲染侧收拢淡出 → CLOSED → hide，超时兜底）；
 *  - 气泡尚未显示（弹出期就绪等待中/被菜单吞）：标记会话作废，弹出流程回来后中止。
 * keepText=true 时保留文本快照（菜单让位专用——菜单关闭后据此恢复气泡；其余路径清文本防误复活）。
 */
function stopSpeech(
  reason: string,
  hard: boolean,
  keepText = false,
  notifyClose = true
): void {
  speechActive = false
  clearSpeechIdleTimer()
  stopSpeechHoverPoll()
  speechIdlePaused = false
  if (!keepText) {
    // 提醒气泡最终关闭 → 未读进列表（菜单让位 keepText 时不算关闭，恢复后仍是同一条）
    if (notifyClose) notifySpeechEvent('closed', reason)
    speechMeta = null
    speechText = ''
    speechIdleEligible = false
    speechIdleOverrideMs = null
    pendingSpeechTtlMs = null
  }
  const showing = isSpeechShowing()
  if (!showing) speechCancelled = true
  console.log(`[bubble] 说话气泡收起（${reason}${hard ? '，硬收' : ''}${showing ? '' : '，弹出中作废'}）`)
  if (!showing) return
  if (hard) finishClose(`说话让位（${reason}）`)
  else closeBubble(`说话收起（${reason}）`)
}

/**
 * 菜单收尾后恢复说话气泡（"不消失"体验闭环）：菜单弹出时说话气泡被硬收（同窗互斥），
 * 菜单关闭时把内容还在的那条重新显示出来（轻量入场、锚点重算——复用 openSpeechBubble 全流程）。
 * 不恢复的情形：菜单里点了教学/展开/设置/隐藏（suppressSpeechRestore 标记）；内容已被清
 * （✕/打断/让位——speechText 为空）；教学/向导中（各自气泡体系）；宠物隐藏中。
 */
function maybeRestoreSpeech(): void {
  if (suppressSpeechRestore || !speechText) {
    // 菜单让位后不恢复（进了教学/设置/隐藏）：提醒气泡此时才算最终关闭 → 进未读列表
    notifySpeechEvent('closed', 'menu-suppressed')
    speechMeta = null
    speechIdleEligible = false
    clearSpeechIdleTimer()
    return
  }
  if (opening) return // 菜单/说话气泡正在打开中（含"重新弹出前收尾"）——不抢场
  if (isSpeechShowing()) return // 已被别的路径恢复/正在显示
  if (getTeachingMode() === 'teaching') return
  const pet = petWin
  if (!pet || pet.isDestroyed() || !pet.isVisible()) return
  console.log('[bubble] 菜单收起——恢复说话气泡（内容仍在）')
  void openSpeechBubble()
}

/**
 * 说话气泡出现（SAY_BEGIN 入口，回复开始）。
 *  - 菜单/确认显示中 → 忽略（用户正在操作菜单，不抢场；本轮 TEXT/END 因 speechActive=false 自然跳过）；
 *  - 幂等：活跃中重复 begin 忽略；
 *  - 常驻复用：上一条还显示中（纯展示态）→ 原地刷新内容（不重播入场）——本函数也被
 *    maybeRestoreSpeech 复用（此时 speechText 已是待恢复内容，**不在本函数内清**：清空在 BEGIN 入口做）；
 *  - 就绪等待期间到达的文本存 speechText，就绪后补发；等待期间会话被取消（如展开进教学）则中止弹出。
 */
async function openSpeechBubble(): Promise<void> {
  if (opening) return
  if (isMenuShowing()) {
    console.log('[bubble] 菜单显示中，本轮说话气泡忽略')
    return
  }
  if (speechActive) return
  opening = true
  try {
    const pet = petWin
    if (!pet || pet.isDestroyed()) return
    if (closing) finishClose('说话气泡弹出前收尾')
    speechActive = true
    speechCancelled = false

    // 常驻复用：上一条还显示着 → 原地刷新（同 session 直接 UPDATE，无入场动画）
    if (isSpeechShowing()) {
      console.log('[bubble] 复用当前说话气泡（原地刷新内容）')
      // 消息属性可能切换（普通回复 ↔ 提醒）：同步给气泡窗，决定「知道了」按钮显隐。
      // 文本仍由随后的 SAY_TEXT 更新（此处保留旧文本，避免闪空）。
      const prev = currentPayload
      if (prev && prev.variant === 'text') {
        currentPayload = { ...prev, meta: speechMeta ?? undefined }
        sendTo(bubbleWin, IPC_BUBBLE.UPDATE, {
          session: prev.session,
          message: prev.message,
          meta: speechMeta ?? undefined
        } as BubbleUpdatePayload)
      }
      startSpeechHoverPoll()
      scheduleSpeechIdleDismiss()
      return
    }

    const a = computeAnchor()
    if (!a) {
      speechActive = false
      return
    }
    anchor = a

    const win = ensureBubbleWindow()
    if (!bubbleReady && !(await waitBubbleReady(READY_TIMEOUT_MS))) {
      console.warn(`[bubble] 气泡页 ${READY_TIMEOUT_MS}ms 未就绪，本次说话气泡取消`)
      speechActive = false
      return
    }
    if (win.isDestroyed()) {
      speechActive = false
      return
    }
    // 等待期间会话可能已被作废（打断 / 展开进教学 / 菜单抢场）——不再弹出
    if (speechCancelled) {
      speechCancelled = false
      speechActive = false
      return
    }

    // 纯展示态但**接鼠标**（悬浮出工具条；不聚焦 showInactive；blur 收起由 interactive 守卫挡掉）。
    // 交互范围由渲染侧上报的形状控制（Linux：形状外完全穿透，不挡桌面；见 REPORT_SHAPE）
    interactive = false
    const payload = buildSpeechPayload(speechText, speechMeta)
    const tail = applyPlacement(win, ESTIMATED_SIZE.text)
    currentPayload = { ...payload, tail }
    lastTail = tail

    win.moveTop() // 与宠物同为 screen-saver 层：显示前 raise 自保
    win.setIgnoreMouseEvents(false)
    applyBubbleShape()
    win.showInactive()
    sendTo(win, IPC_BUBBLE.OPEN, currentPayload)
    scheduleOpenRepost(win)
    forceRepaint(win) // 显示后再补一发（applyPlacement 已重绘一次——双保险，防"显示后"绘制未同步）
    console.log(
      `[bubble] 说话气泡已弹出 @ ${win.getBounds().x},${win.getBounds().y}（tail=${tail}，悬浮可交互）`
    )
    // 就绪等待期间到达的文本：立即补上（气泡不空等下一条 TEXT）
    if (speechText) updateSpeechBubble(speechText)
    startSpeechHoverPoll()
    scheduleSpeechIdleDismiss()
  } catch (err) {
    console.error('[bubble] 弹出说话气泡异常：', err)
    speechActive = false
  } finally {
    opening = false
  }
}

/**
 * 说话气泡文本快照更新（SAY_TEXT）：同 session UPDATE（只换文字不重播入场）。
 * 窗未显示时（就绪等待中/已被收起）只存快照——begin 完成后补发。
 */
function updateSpeechBubble(text: string): void {
  speechText = text
  clearSpeechIdleTimer()
  if (!speechActive || !isSpeechShowing()) return
  const win = bubbleWin
  const payload = currentPayload
  // variant 判空兜底（isSpeechShowing 已保证是 text；此处同时给 TS 收窄联合类型）
  if (!win || !payload || payload.variant !== 'text') return
  currentPayload = { ...payload, message: text, meta: speechMeta ?? undefined }
  const update: BubbleUpdatePayload = {
    session: payload.session,
    message: text,
    meta: speechMeta ?? undefined
  }
  sendTo(win, IPC_BUBBLE.UPDATE, update)
  // 菜单恢复等"已结束但 speechActive 仍为 true"的路径：文本更新后重新计时
  if (speechIdleEligible) scheduleSpeechIdleDismiss()
}

/**
 * 说话结束（SAY_END）：
 *  - immediate（被打断/教学向导让位）——无论气泡是否已显示，立刻收起/作废（清文本，不复活）；
 *  - 缺省——**常驻**（2026-10-16 用户定稿"回复的消息不要消失"）：回复结束气泡留在兔子头旁，
 *    等用户处理（悬浮 ✕ 收掉 / 新回复原地替换 / 菜单让位后恢复 / 教学向导让位）。
 * 菜单显示中（variant=menu）两路都不动它（isSpeechShowing 守卫）。
 */
function endSpeechBubble(immediate: boolean): void {
  if (immediate) {
    speechIdleEligible = false
    clearSpeechIdleTimer()
    if (speechActive || isSpeechShowing()) stopSpeech('被打断/让位', false)
    return
  }
  // 常驻：仅复位会话活跃标志（本轮不再接收 TEXT）——气泡保持显示，开始空闲计时
  if (!speechActive) {
    // 菜单让位期间到达的 SAY_END：文本被 keepText 保留，菜单关闭恢复后应继续计时
    if (speechText) {
      speechIdleEligible = true
      scheduleSpeechIdleDismiss()
    }
    return
  }
  speechActive = false
  speechIdleEligible = true
  console.log(
    `[bubble] 说话结束（${speechText.length} 字）——气泡常驻，${speechIdleMs > 0 ? `${speechIdleMs}ms 空闲后收起` : '不自动收起'}`
  )
  scheduleSpeechIdleDismiss()
}

/**
 * 宠物移动跟随（说话气泡绑定兔子：走动/拖拽时随机重摆；菜单/确认态不跟随——弹窗语义）。
 * 'move' 事件高频（走动=窗口缓动、拖动=逐帧 setBounds）——FOLLOW_THROTTLE_MS 节流；直接 setBounds
 * 跟手（不播动画、不重播入场）。拖动期间锚点需现算（applyPlacement 用的是缓存 anchor）。
 */
function onPetMoved(): void {
  if (!isSpeechShowing()) return
  if (followPending) return
  followPending = true
  setTimeout(() => {
    followPending = false
    const win = bubbleWin
    if (!win || win.isDestroyed() || !isSpeechShowing()) return
    const a = computeAnchor()
    if (!a) return
    anchor = a
    // 尺寸取渲染侧上报的内容尺寸——**不要用 win.getBounds()**（Windows fractional DPI 下
    // get→set 回喂会每次 +1px 累积；见 contentSize 注释与 geometry.followSize）。尚未收到上报
    // （极早期）用文本预估值。
    reposition(win, followSize(contentSize, ESTIMATED_SIZE.text))
  }, FOLLOW_THROTTLE_MS)
}

/**
 * 弹出菜单气泡（本轮唯一入口：宠物窗右键）。
 * 幂等收敛：正在弹出（异步就绪等待中）时忽略重复请求；已在显示 → 重定位 + 重发内容
 * （气泡"弹一下"刷新观感，不重窗）；正在收起（如右键抢焦点触发的 blur 半收）→ 先收尾再开。
 */
async function openMenuBubble(): Promise<void> {
  if (opening) return
  // 右键菜单抢场：任何待确认动作按取消处理（用户已经转向别的操作）
  settleConfirm(false)
  opening = true
  try {
    const pet = petWin
    if (!pet || pet.isDestroyed()) {
      console.warn('[bubble] 宠物窗口不可用，无法弹出气泡')
      return
    }
    suppressSpeechRestore = false // 新菜单会话：普通关闭（blur）时恢复说话气泡（"不消失"闭环）
    // 说话气泡让位：同一气泡窗不能同时服务两种内容——硬收（保留文本快照，菜单关闭后恢复）；
    // 本轮说话后续的 TEXT/END 因 speechActive 已复位而自然跳过
    if (speechActive || isSpeechShowing()) stopSpeech('菜单让位', true, true)
    // 收起中（右键抢焦点 → blur 已触发收起）→ 直接完成收尾：下面按"重新打开"走一遍（新 session 重播入场）
    if (closing) finishClose('重新弹出前收尾')
    interactive = true // 菜单态（防上一轮说话气泡纯展示态的 blur 守卫残留）

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
    scheduleOpenRepost(win)
    console.log(`[bubble] 菜单气泡已弹出 @ ${win.getBounds().x},${win.getBounds().y}（tail=${tail}）`)
  } catch (err) {
    console.error('[bubble] 弹出菜单气泡异常：', err)
  } finally {
    opening = false
  }
}

/**
 * 弹出确认气泡并等待用户选择（2026-10-18 泛化）。
 *
 * - 同一时间只有一个待确认动作；新请求会把旧请求按取消结清；
 * - 用户点「确认」：执行 onConfirm（可为空——删除文件由 IPC 处理器在拿到
 *   ``true`` 后执行），resolve(true)，收起气泡；
 * - 取消 / 点别处 / 120s 超时：resolve(false)，**什么都不做**；
 * - 说话气泡让位（保留文本），确认关闭后由 maybeRestoreSpeech 恢复——
 *   删除确认不吞掉宠物刚说的话。
 */
export async function openConfirmBubble(request: ConfirmRequest): Promise<boolean> {
  settleConfirm(false)
  if (opening) {
    console.warn('[bubble] 气泡正在弹出，确认请求忽略')
    return false
  }
  const pet = petWin
  if (!pet || pet.isDestroyed()) {
    console.warn('[bubble] 宠物窗口不可用，无法弹出确认气泡')
    return false
  }

  opening = true
  let resolvePromise: (confirmed: boolean) => void = () => {}
  const result = new Promise<boolean>((resolve) => {
    resolvePromise = resolve
  })
  try {
    // 说话气泡让位：保留文本，确认关闭后恢复
    if (speechActive || isSpeechShowing()) stopSpeech('确认让位', true, true)
    if (closing) finishClose('确认弹出前收尾')
    interactive = true

    const a = computeAnchor()
    if (!a) return false
    anchor = a

    const win = ensureBubbleWindow()
    if (!bubbleReady && !(await waitBubbleReady(READY_TIMEOUT_MS))) {
      console.warn(`[bubble] 气泡页 ${READY_TIMEOUT_MS}ms 未就绪，确认请求取消`)
      return false
    }
    if (win.isDestroyed()) return false

    // 组装内容 → 预估尺寸定位 → 显示并聚焦（确认态 = 可点，像原生弹窗）
    const payload = buildConfirmPayload(request)
    const tail = applyPlacement(win, ESTIMATED_SIZE.confirm)
    currentPayload = { ...payload, tail }
    lastTail = tail

    pendingConfirm = {
      onConfirm: request.onConfirm ?? (() => {}),
      resolve: resolvePromise,
      timer: setTimeout(() => {
        console.log(`[bubble] 确认气泡 ${CONFIRM_TIMEOUT_MS}ms 无操作，按取消处理`)
        settleConfirm(false)
        closeBubble('确认超时')
      }, CONFIRM_TIMEOUT_MS)
    }
    pendingConfirm.timer?.unref?.()

    win.moveTop()
    win.setIgnoreMouseEvents(false)
    win.show()
    win.focus()
    sendTo(win, IPC_BUBBLE.OPEN, currentPayload)
    scheduleOpenRepost(win)
    console.log('[bubble] 确认气泡已弹出（等待用户选择）')
    return result
  } catch (err) {
    console.error('[bubble] 弹出确认气泡异常：', err)
    settleConfirm(false)
    return false
  } finally {
    opening = false
  }
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
 * 说话气泡动作（悬浮工具条）：expand = 带记录进教学（enterTeaching('bubble')，prefill 由宠物面
 * 见 reason 后 seed）；close = 收掉当前消息（✕）。
 */
function dispatchAction(id: string): void {
  const payload = currentPayload
  if (!payload) return
  const allowed =
    payload.variant === 'menu'
      ? MENU_ACTION_IDS.includes(id)
      : payload.variant === 'confirm'
        ? CONFIRM_ACTION_IDS.includes(id)
        : payload.variant === 'text'
          ? SPEECH_ACTION_IDS.includes(id)
          : false
  if (!allowed) {
    console.warn(`[bubble] 忽略非法动作 id：${id}`)
    return
  }
  console.log(`[bubble] 动作：${id}`)

  switch (id) {
    case 'teaching':
      suppressSpeechRestore = true // 进教学：菜单关闭后不恢复气泡（清文本防复活）
      speechText = ''
      if (getTeachingMode() === 'teaching') void exitTeaching('menu')
      else void enterTeaching('menu')
      closeBubble('动作：教学')
      break
    case 'work':
      // 工作模式：只是打开一个额外的聊天窗，说话气泡照常恢复（不抑制）
      openWork()
      closeBubble('动作：工作模式')
      break
    case 'settings':
      suppressSpeechRestore = true // 进设置向导：同理不恢复（向导有自己的萌语气泡）
      speechText = ''
      openSettings()
      closeBubble('动作：设置')
      break
    case 'hide-pet': {
      suppressSpeechRestore = true // 宠物隐藏：气泡不恢复
      speechText = ''
      const pet = petWin
      if (pet && !pet.isDestroyed()) void runHideAnimation(pet)
      closeBubble('动作：隐藏')
      break
    }
    case 'clear-chat':
      // 清空 = 破坏性操作：先换确认气泡（不关窗），确认后才执行。
      // 清空后不恢复旧说话气泡（内容已经不要了）
      suppressSpeechRestore = true
      speechText = ''
      void openConfirmBubble({ ...CLEAR_CHAT_CONFIRM, onConfirm: requestClearChat })
      break
    case 'confirm': {
      // 确认气泡是泛化的：当前待确认动作可能是清空聊天，也可能是删除文件
      const pending = pendingConfirm
      if (!pending) {
        console.warn('[bubble] 收到 confirm，但没有待确认动作（已过期/重复点击）')
        closeBubble('动作：确认（无待确认项）')
        break
      }
      try {
        const action: unknown = pending.onConfirm()
        if (action && typeof (action as Promise<void>).catch === 'function') {
          void (action as Promise<void>).catch((err) => {
            console.warn('[bubble] 确认动作执行失败（忽略）：', err)
          })
        }
      } catch (err) {
        console.warn('[bubble] 确认动作执行失败（忽略）：', err)
      }
      settleConfirm(true)
      closeBubble('动作：确认')
      break
    }
    case 'cancel':
      settleConfirm(false)
      closeBubble('动作：取消')
      break
    case 'expand':
      // 说话气泡「展开」（悬浮工具条）：带聊天记录进入教学——黑板滑出 + 兔子站讲台位 + 记录预填
      // （预填由宠物面收到 state.reason='bubble' 后自行 seed，经既有镜像通道）。本气泡硬收，
      // 且菜单/退出后都不恢复（用户定稿：进去看记录即替代气泡）
      suppressSpeechRestore = true
      stopSpeech('展开进教学', true)
      void enterTeaching('bubble')
      break
    case 'close':
      // 说话气泡「✕」：收掉当前消息（清文本——后续菜单关闭不复活）。
      // 提醒气泡的 ✕ 不等于已读：stopSpeech 会回传 closed，未读进列表。
      stopSpeech('气泡 ✕', false)
      break
    case 'reminder-ack':
      // 提醒气泡「知道了」：回执已读（宠物面发 ack_reminders），然后收起且不再进未读列表
      if (speechMeta?.kind !== 'reminder') {
        console.warn('[bubble] 忽略非提醒气泡的 reminder-ack')
        break
      }
      notifySpeechEvent('reminder-ack', '知道了')
      speechMeta = null
      speechText = ''
      speechIdleEligible = false
      stopSpeech('提醒已读', false, false, false)
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

  // 说话气泡跟随：宠物走动/被拖拽时气泡随机重摆（见 onPetMoved；监听只注册一次）
  petWin.on('move', onPetMoved)

  // 弹出请求：唯一入口 = 宠物窗（右键菜单）；其它渲染面/脏载荷一律忽略
  ipcMain.on(IPC.BUBBLE_REQUEST_OPEN, (event, request: unknown) => {
    if (!isPetSender(event.sender)) return
    if (!isMenuRequest(request)) return
    // 右键实际落在说话气泡上、但事件被宠物窗收到：不要走菜单让位（会收掉气泡），
    // 改为气泡的复制菜单（选中文本从气泡页现取）。
    const requestX = Number(request.x)
    const requestY = Number(request.y)
    const point: Point =
      Number.isFinite(requestX) && Number.isFinite(requestY)
        ? { x: requestX, y: requestY }
        : screen.getCursorScreenPoint()
    if (isSpeechShowing() && pointInsideBubble(point)) {
      const win = bubbleWin
      console.log('[bubble] 右键落在说话气泡上 → 改为复制菜单（不让位宠物菜单）')
      if (win && !win.isDestroyed()) {
        void win.webContents
          .executeJavaScript(`window.getSelection ? window.getSelection().toString() : ''`)
          .then((text: unknown) => showSpeechContextMenu(typeof text === 'string' ? text : ''))
          .catch(() => showSpeechContextMenu(''))
      } else {
        showSpeechContextMenu('')
      }
      return
    }
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
    reposition(win, { width, height })
    console.log(
      `[bubble] 尺寸上报 ${Math.round(width)}x${Math.round(height)} → 窗 ${win.getBounds().width}x${win.getBounds().height}（tail=${lastTail}）`
    )
  })

  // 内容交互矩形上报（说话气泡悬浮交互；Linux 据此 setShape 裁输入区，形状外完全穿透）
  ipcMain.on(IPC_BUBBLE.REPORT_SHAPE, (event, rects: unknown) => {
    if (!isBubbleSender(event.sender)) return
    if (!Array.isArray(rects)) return
    const cleaned: Rect[] = []
    for (const item of rects) {
      const r = item as Partial<Rect> | null
      const x = Number(r?.x)
      const y = Number(r?.y)
      const width = Number(r?.width)
      const height = Number(r?.height)
      if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) continue
      cleaned.push({
        x: Math.round(x),
        y: Math.round(y),
        width: Math.round(width),
        height: Math.round(height)
      })
    }
    if (cleaned.length === 0) return
    shapeRects = cleaned
    applyBubbleShape()
  })

  // 说话气泡三件套（场景3；只认宠物窗——chat 域的驱动）：出现/文本快照/结束
  ipcMain.on(IPC_BUBBLE.SAY_BEGIN, (event, payload: unknown) => {
    if (!isPetSender(event.sender)) return
    const nextMeta: BubbleSpeechMeta =
      (payload as BubbleSayBeginPayload | null)?.meta ?? { kind: 'chat' }
    // 新消息替换旧提醒气泡：旧批次此时才算关闭 → 未读进列表（新批次随后接管气泡）
    if (speechMeta?.kind === 'reminder' && !sameSpeechMeta(speechMeta, nextMeta)) {
      notifySpeechEvent('closed', 'replaced')
    }
    speechMeta = nextMeta
    clearSpeechIdleTimer()
    speechIdleEligible = false
    // 本地短提示（不支持文件等）预置的 5s 只消费一次；普通回复回落设置值
    if (pendingSpeechTtlMs !== null) {
      speechIdleOverrideMs = pendingSpeechTtlMs
      pendingSpeechTtlMs = null
    } else {
      speechIdleOverrideMs = null
    }
    // 不清 speechIdlePaused：气泡原地复用时鼠标可能仍在上面，保留渲染侧上报的悬浮/选区状态
    speechText = '' // 新会话清快照（maybeRestoreSpeech 复用 openSpeechBubble 时不经过本入口，文本得以保留）
    void openSpeechBubble()
  })
  ipcMain.on(IPC_BUBBLE.SAY_TEXT, (event, payload: unknown) => {
    if (!isPetSender(event.sender)) return
    const text = (payload as BubbleSayTextPayload | null)?.text
    if (typeof text !== 'string') return
    updateSpeechBubble(text)
  })
  ipcMain.on(IPC_BUBBLE.SAY_END, (event, payload: unknown) => {
    if (!isPetSender(event.sender)) return
    endSpeechBubble((payload as BubbleSayEndPayload | null)?.immediate === true)
  })

  // 本地短提示（不支持文件等）：只覆盖下一次 SAY_BEGIN 的空闲时长（5s），不影响普通回复设置
  ipcMain.on(IPC_BUBBLE.SET_NEXT_SPEECH_TTL, (event, ms: unknown) => {
    if (!isPetSender(event.sender)) return
    const value = Number(ms)
    if (!Number.isFinite(value)) return
    pendingSpeechTtlMs = Math.min(60_000, Math.max(1_000, Math.round(value)))
    console.log(`[bubble] 下一轮说话临时空闲时长 -> ${pendingSpeechTtlMs}ms`)
  })

  // 回复气泡自动收起：设置时长（宠物面）/ 新消息重置（宠物面）/ 悬浮选中暂停（气泡面）
  ipcMain.on(IPC_BUBBLE.SET_IDLE_TTL, (event, seconds: unknown) => {
    if (!isPetSender(event.sender)) return
    const value = Number(seconds)
    if (!Number.isFinite(value)) return
    speechIdleMs =
      value <= 0 ? 0 : Math.min(300, Math.max(5, Math.round(value))) * 1000
    console.log(
      `[bubble] 回复气泡空闲收起时长 -> ${speechIdleMs > 0 ? `${speechIdleMs}ms` : '不自动收'}`
    )
    clearSpeechIdleTimer()
    if (speechIdleEligible) scheduleSpeechIdleDismiss()
  })
  ipcMain.on(IPC_BUBBLE.SPEECH_TOUCH, (event) => {
    if (!isPetSender(event.sender)) return
    if (!speechIdleEligible) return
    scheduleSpeechIdleDismiss()
  })
  ipcMain.on(IPC_BUBBLE.SPEECH_ACTIVITY, (event, payload: unknown) => {
    if (!isBubbleSender(event.sender)) return
    const paused = (payload as { paused?: unknown } | null)?.paused === true
    speechIdlePaused = paused
    if (paused) clearSpeechIdleTimer()
    else if (!speechHoverInside && speechIdleEligible) scheduleSpeechIdleDismiss()
  })
  ipcMain.on(IPC_BUBBLE.REQUEST_CONTEXT_MENU, (event, payload: unknown) => {
    if (!isBubbleSender(event.sender)) return
    const selectionText = (payload as { selectionText?: unknown } | null)?.selectionText
    if (typeof selectionText !== 'string') return
    showSpeechContextMenu(selectionText)
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

  // Windows（复用策略）：延迟预热气泡窗——隐藏创建 + 加载页面，首次右键菜单/回复不必再等
  // 渲染进程与页面冷启动（dev 冷启动实测首弹约 0.5s；预热后首次也只需 show + 下发内容）。
  // 延迟 1.5s 避免和启动阶段（后端/宠物窗）抢资源；Linux/macOS 走销毁重建，不预热。
  if (REUSE_BUBBLE_WINDOW) {
    warmTimer = setTimeout(() => {
      warmTimer = null
      if (!bubbleWin) {
        console.log('[bubble] 预热气泡窗（Windows 复用策略）')
        ensureBubbleWindow()
      }
    }, 1500)
  }
}
