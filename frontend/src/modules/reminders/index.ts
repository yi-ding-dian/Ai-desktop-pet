/**
 * 提醒域（2026-10-18）：未读提醒列表 + 到点气泡 + 系统通知。
 *
 * 两层展示（用户定稿）：
 *  1. **气泡**：到点先弹普通提醒气泡（60s；语音默认关闭，但气泡一定出）；
 *     气泡 meta 标记为 reminder，悬浮条显示「知道了」。点「知道了」= 整批已读；
 *     不点/超时/被替换 → 主进程回传 closed，本域把整批并入右侧未读列表。
 *  2. **未读列表**（electron/reminder-list 独立窗，不在托盘）：宠物右侧优先、左侧回退、
 *     两侧都不够用紧凑条；折叠显示最新 2 条，右上角数字可展开全部。
 *  3. **时钟视图 + 灰灯**：时钟入口显示当天事件 + 所有未到期计划（灰点）；
 *     未读列表底部灰灯点击后向下展开待提醒，点别处收起（2026-10-18）。
 *
 * 数据源：
 *  - 后端 `reminder_events` 是未读的事实来源；`reminders` 表提供未到期计划；
 *    本域连接后 `get_reminders` 拉快照（含 pending），气泡展示期间把该批事件从
 *    列表里**过滤掉**（activeIds），关闭后再显示；
 *  - 列表点条目/全部知道了 → `ack_reminders`；后端回新快照；
 *  - 重启后未读自动恢复（不依赖前端内存）。
 *
 * 抑制/离开：
 *  - 教学/设置向导/宠物隐藏：列表与气泡都让位，系统通知兜底（配置可关）；
 *  - 用户离开（系统空闲 ≥ 2 分钟）：即使宠物可见也补系统通知，回来列表还在。
 */
import { getPetBridge } from '../../shared/pet-bridge'
import type { WsClient } from '../../shared/ws-client'
import type {
  ProactiveData,
  ReminderHistoryData,
  ReminderItemData,
  RemindersData
} from '../../shared/protocol'
import type {
  BubbleSpeechEventPayload,
  BubbleSpeechMeta,
  ReminderListActionPayload
} from '../../../electron/ipc/channels'
import { speakReminder } from '../chat'

/** 提醒气泡停留时长（ms；主进程 SET_NEXT_SPEECH_TTL 上限 60s） */
const REMINDER_TTL_MS = 60_000
/** 排队重试间隔（ms）：回复结束 / 教学退出 / 宠物重新显示后尽快补气泡 */
const RETRY_MS = 5_000
/** 多条排队提醒之间的展示间隔（ms）：避免前一条刚看到就被下一条覆盖 */
const GAP_MS = 15_000
/** 排队上限（防长时间抑制态内存增长；超出丢最旧的） */
const MAX_PENDING = 5
/** 系统空闲超过该秒数视为"用户不在电脑旁" */
const AWAY_IDLE_SECONDS = 120
/** 未读列表可见性轮询（ms；教学/向导/隐藏状态变化没有统一事件，轻量轮询兜底） */
const LIST_VISIBLE_POLL_MS = 3_000

export interface ReminderOptions {
  /** 抑制判定（教学 / 设置向导中返回 true）：每次现读，闭包捕获的旧状态会漏判 */
  shouldSuppress: () => boolean
}

interface PendingReminder {
  text: string
  meta: BubbleSpeechMeta
}

/** 系统通知的宽容封装（旧 preload 无 system.notify / 浏览器调试时静默跳过） */
function notifySystem(text: string): void {
  try {
    getPetBridge().system?.notify?.('小兔提醒', text)
  } catch {
    /* bridge 缺失：气泡/列表仍是主通道，通知失败不影响提醒 */
  }
}

/** 宠物窗是否真的可见（页面层 + 主进程窗口层；查不到时保守按可见处理） */
async function petVisible(): Promise<boolean> {
  try {
    const api = getPetBridge().window
    if (typeof api?.isVisible === 'function') return await api.isVisible()
  } catch {
    /* 旧 preload：退回页面层判定 */
  }
  return document.visibilityState === 'visible'
}

/** 用户是否离开（系统空闲 ≥ 2 分钟；查不到按未离开） */
async function userAway(): Promise<boolean> {
  try {
    const seconds = await getPetBridge().system.getIdleSeconds()
    return Number.isFinite(seconds) && seconds >= AWAY_IDLE_SECONDS
  } catch {
    return false
  }
}

/**
 * 接线提醒展示（App 挂载时调用一次）。返回取消订阅/清理函数。
 */
export function setupReminders(client: WsClient, options: ReminderOptions): () => void {
  let disposed = false
  /** 等待补气泡的提醒（抑制/隐藏/流式期间临时排队） */
  let pending: PendingReminder[] = []
  let queueTimer: number | null = null
  /** 宠物隐藏/抑制时是否补系统通知（配置 [reminders].os_notification_when_hidden） */
  let notifyWhenHidden = true
  /** 最近一次气泡展示时间（多条提醒同时到达时按 GAP_MS 排队，避免互相覆盖） */
  let lastShownAt = 0

  // ---- 未读列表状态（后端快照 + 当前气泡中的批次过滤） ----
  let unread: ReminderItemData[] = []
  let unreadCount = 0
  /** 尚未到期的计划（灰灯；底部灰灯展开时显示） */
  let pendingReminders: ReminderItemData[] = []
  /** 尚未到期的提醒数（时钟入口/列表底部灰灯入口） */
  let pendingCount = 0
  /** 底部灰灯是否展开（仅未读视图；点击面板外收起） */
  let pendingExpanded = false
  /** 列表视图：unread=未读；today=当天全部（已读 + 未读 + 未到期，标题右侧时钟入口切换） */
  let viewMode: 'unread' | 'today' = 'unread'
  let history: ReminderItemData[] = []
  let historyTotal = 0
  /** 当前气泡正在展示的事件 id（不出现在右侧列表里，关闭后解除过滤） */
  let activeIds = new Set<string>()
  let activeBatchId: string | null = null
  /** 已发过系统通知的批次（防同一批重复弹通知） */
  const notifiedBatches = new Set<string>()
  let publishTimer: number | null = null
  let publishSeq = 0
  let pollTimer: number | null = null

  const bridgeApi = (): ReturnType<typeof getPetBridge> | null => {
    try {
      return getPetBridge()
    } catch {
      return null
    }
  }

  const hiddenNow = (): boolean => document.visibilityState !== 'visible'

  const listBridge = () => bridgeApi()?.reminderList

  const publishList = async (): Promise<void> => {
    const seq = ++publishSeq
    const visible = !options.shouldSuppress() && !hiddenNow() && (await petVisible())
    if (disposed || seq !== publishSeq) return
    const listBridgeNow = listBridge()
    if (!listBridgeNow) return

    if (viewMode === 'today') {
      // 时钟入口视图：已读 + 未读 + 未到期全列，按到期时间正序（后端已排序）；
      // 不按 activeIds 过滤（pending 项没有事件 id，也不会被气泡占用）
      listBridgeNow.update({
        mode: 'today',
        items: history.map((item) => ({
          id: item.id,
          text: item.text,
          timeText: item.time_text || '',
          late: item.late === true,
          acknowledged: item.acknowledged === true,
          pending: item.pending === true
        })),
        unreadCount: historyTotal,
        pendingItems: [],
        pendingExpanded: false,
        pendingCount,
        bellOnly: false,
        visible
      })
      return
    }

    const shown = unread.filter((item) => !activeIds.has(item.id))
    // 只扣掉"快照里确实存在的活跃项"：proactive 先于事件落库到达时，不能把已有未读数扣错
    const activeInSnapshot = unread.reduce(
      (total, item) => total + (activeIds.has(item.id) ? 1 : 0),
      0
    )
    const count = Math.max(0, unreadCount - activeInSnapshot)
    // 没有未读、但还有待提醒：只显示一个常驻灰灯小球（不占大面板）；
    // 点击后 pendingExpanded=true 展开成待提醒面板。
    const bellOnly = count === 0 && pendingCount > 0 && !pendingExpanded
    listBridgeNow.update({
      mode: 'unread',
      items: shown.map((item) => ({
        id: item.id,
        text: item.text,
        timeText: item.time_text || '',
        late: item.late === true,
        acknowledged: false,
        pending: false
      })),
      pendingItems: pendingReminders.map((item) => ({
        id: item.id,
        text: item.text,
        timeText: item.time_text || '',
        late: item.late === true,
        acknowledged: false,
        pending: true
      })),
      pendingExpanded,
      unreadCount: count,
      pendingCount,
      bellOnly,
      visible
    })
  }

  const schedulePublish = (delay = 60): void => {
    if (disposed) return
    if (publishTimer !== null) return
    publishTimer = window.setTimeout(() => {
      publishTimer = null
      void publishList()
    }, delay)
  }

  const ensurePoll = (): void => {
    if (pollTimer !== null || disposed) return
    pollTimer = window.setInterval(() => {
      // 未读/待提醒/时钟视图都需要持续判定教学、向导、宠物显隐
      if (unreadCount > 0 || pendingCount > 0 || viewMode === 'today') {
        schedulePublish()
      } else {
        stopPoll()
      }
    }, LIST_VISIBLE_POLL_MS)
  }

  const stopPoll = (): void => {
    if (pollTimer !== null) {
      window.clearInterval(pollTimer)
      pollTimer = null
    }
  }

  const applySnapshot = (data: RemindersData): void => {
    unread = Array.isArray(data.items) ? data.items : []
    unreadCount =
      typeof data.unread_count === 'number' ? Math.max(0, data.unread_count) : unread.length
    pendingReminders = Array.isArray(data.pending) ? data.pending : []
    pendingCount =
      typeof data.pending_count === 'number'
        ? Math.max(0, data.pending_count)
        : pendingReminders.length
    if (pendingReminders.length === 0) pendingExpanded = false
    schedulePublish()
    if (unreadCount > 0 || pendingCount > 0 || activeIds.size > 0) ensurePoll()
    else stopPoll()
  }

  const refreshUnread = (): void => {
    client.send('get_reminders', { limit: 100 })
  }

  const refreshHistory = (): void => {
    const now = new Date()
    const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(
      now.getDate()
    ).padStart(2, '0')}`
    client.send('get_reminder_history', { date })
  }

  const applyHistory = (data: ReminderHistoryData): void => {
    history = Array.isArray(data.items) ? data.items : []
    pendingCount =
      typeof data.pending_count === 'number'
        ? Math.max(0, data.pending_count)
        : history.filter((item) => item.pending === true).length
    historyTotal = Math.max(
      history.length,
      (data.read_count || 0) + (data.unread_count || 0) + pendingCount
    )
    if (viewMode === 'today') schedulePublish()
    ensurePoll()
  }

  const setActive = (meta: BubbleSpeechMeta): void => {
    activeBatchId = meta.batchId ?? null
    activeIds = new Set(meta.eventIds ?? [])
    schedulePublish()
  }

  const clearActive = (batchId?: string | null): void => {
    if (batchId && activeBatchId && batchId !== activeBatchId) return
    activeBatchId = null
    activeIds = new Set()
    schedulePublish()
  }

  // ---- 气泡排队 ----

  const clearQueueTimer = (): void => {
    if (queueTimer !== null) {
      window.clearTimeout(queueTimer)
      queueTimer = null
    }
  }

  const scheduleQueue = (delay: number): void => {
    if (disposed || queueTimer !== null) return
    queueTimer = window.setTimeout(() => {
      queueTimer = null
      void flush()
    }, delay)
  }

  /** 当前是否允许直接弹气泡（非抑制态、页面可见、宠物窗可见） */
  const canShow = async (): Promise<boolean> => {
    if (options.shouldSuppress()) return false
    if (hiddenNow()) return false
    return petVisible()
  }

  const showBubble = (item: PendingReminder): boolean => {
    if (!speakReminder(item.text, REMINDER_TTL_MS, item.meta)) return false
    setActive(item.meta)
    lastShownAt = Date.now()
    console.log(`[reminders] 提醒气泡已展示：${item.text}`)
    return true
  }

  /** 环境允许时展示队首提醒；仍被抑制/流式中则继续等 */
  const flush = async (): Promise<void> => {
    if (disposed || pending.length === 0) return
    if (!(await canShow())) {
      scheduleQueue(RETRY_MS)
      return
    }
    if (disposed || pending.length === 0) return
    // 上一条提醒气泡还在停留期：等够 GAP_MS 再换下一条，避免快速覆盖
    if (lastShownAt > 0) {
      const wait = GAP_MS - (Date.now() - lastShownAt)
      if (wait > 0) {
        scheduleQueue(wait)
        return
      }
    }
    const item = pending[0]
    if (!showBubble(item)) {
      scheduleQueue(RETRY_MS)
      return
    }
    pending.shift()
    if (pending.length > 0) scheduleQueue(GAP_MS)
  }

  const queue = (item: PendingReminder, delay = RETRY_MS): void => {
    if (pending.length >= MAX_PENDING) pending.shift()
    pending.push(item)
    scheduleQueue(delay)
    schedulePublish()
  }

  // ---- 后端 proactive ----

  const proactiveItems = (data: ProactiveData): ReminderItemData[] => {
    if (Array.isArray(data.items) && data.items.length > 0) return data.items
    // 兼容旧后端（无 items）：至少让气泡显示，已读回执退化为 message_id
    return [
      {
        id: data.reminder_id || data.message_id,
        reminder_id: data.reminder_id || '',
        text: data.text,
        due_at: data.due_at || '',
        fired_at: '',
        late: data.late === true,
        acknowledged: false,
        time_text: ''
      }
    ]
  }

  const handleProactive = async (data: ProactiveData): Promise<void> => {
    const text = (data.text ?? '').trim()
    if (!text) return
    const items = proactiveItems(data)
    const meta: BubbleSpeechMeta = {
      kind: 'reminder',
      messageId: data.message_id,
      batchId: data.batch_id ?? undefined,
      eventIds: items.map((item) => item.id)
    }
    const suppressed = options.shouldSuppress()
    const hidden = hiddenNow() || !(await petVisible())
    const away = await userAway()
    if (disposed) return

    // 事件在 proactive 之后才落库：稍后拉一次快照，队列中的提醒/未读数才能进入列表
    window.setTimeout(() => {
      if (disposed) return
      refreshUnread()
      if (viewMode === 'today') refreshHistory()
    }, 400)

    const batchKey = data.batch_id || data.message_id
    if ((suppressed || hidden) && notifyWhenHidden && !notifiedBatches.has(batchKey)) {
      notifiedBatches.add(batchKey)
      notifySystem(text)
    } else if (away && !notifiedBatches.has(batchKey)) {
      // 用户在电脑旁但已离开（宠物仍可见）：补系统通知，回来靠右侧列表看
      notifiedBatches.add(batchKey)
      notifySystem(text)
    }

    if (suppressed || hidden) {
      // 教学/向导/宠物隐藏：气泡排队等环境恢复；未读列表也由 visible=false 让位
      queue({ text, meta })
      return
    }

    const sinceLast = Date.now() - lastShownAt
    if (pending.length === 0 && sinceLast >= GAP_MS && showBubble({ text, meta })) {
      return
    }
    // 流式回复中 / 上一条提醒刚展示：排队，不打断也不互相覆盖
    queue({ text, meta }, pending.length === 0 ? Math.max(RETRY_MS, GAP_MS - sinceLast) : RETRY_MS)
  }

  // ---- 气泡生命周期（主进程回传） ----

  /** 从排队气泡里移除已读事件（列表里点了某条/全部知道了 → 后续不应再弹） */
  const dropPending = (ids?: string[]): void => {
    if (!ids || ids.length === 0) {
      pending = []
      clearQueueTimer()
      return
    }
    const drop = new Set(ids)
    pending = pending.filter(
      (item) => !(item.meta.eventIds ?? []).some((id) => drop.has(id))
    )
    if (pending.length === 0) clearQueueTimer()
  }

  const onSpeechEvent = (payload: BubbleSpeechEventPayload): void => {
    if (payload.meta?.kind !== 'reminder') return
    if (payload.type === 'reminder-ack') {
      clearActive(payload.meta.batchId)
      const ids = payload.meta.eventIds ?? []
      dropPending(ids)
      if (ids.length > 0) client.send('ack_reminders', { ids })
      else refreshUnread()
      if (viewMode === 'today') refreshHistory()
      return
    }
    // closed：气泡已收起但用户没点「知道了」→ 这一批进右侧未读列表
    clearActive(payload.meta.batchId)
    refreshUnread()
    if (viewMode === 'today') refreshHistory()
  }

  const onListAction = (action: ReminderListActionPayload): void => {
    if (action.type === 'pending-expand') {
      if (pendingReminders.length > 0) {
        pendingExpanded = true
        schedulePublish()
      }
      return
    }
    if (action.type === 'pending-collapse') {
      pendingExpanded = false
      schedulePublish()
      return
    }
    if (action.type === 'history') {
      pendingExpanded = false
      viewMode = 'today'
      schedulePublish() // 先用现有历史立即切换（空则显示“还没有提醒”）
      refreshHistory()
      return
    }
    if (action.type === 'unread') {
      pendingExpanded = false
      viewMode = 'unread'
      schedulePublish()
      refreshUnread()
      return
    }
    if (action.type === 'delete') {
      if (action.id) {
        // 删除后后端回未读快照 + 时钟视图快照，两个视图自然收敛
        client.send('delete_reminder_item', { id: action.id })
      }
      return
    }
    if (action.type === 'ack') {
      if (action.id) {
        dropPending([action.id])
        client.send('ack_reminders', { ids: [action.id] })
        if (viewMode === 'today') refreshHistory()
      }
      return
    }
    if (action.type === 'ack-all') {
      dropPending()
      client.send('ack_reminders', { all: true })
      if (viewMode === 'today') refreshHistory()
    }
  }

  // ---- 订阅 ----

  const offs = [
    client.on('proactive', (data) => {
      if (data.kind !== 'reminder') return // 未来 greeting 等类型在此扩展
      void handleProactive(data)
    }),
    client.on('reminders', (data) => applySnapshot(data)),
    client.on('reminder_history', (data) => applyHistory(data)),
    client.on('notice', (data) => {
      // 聊天里新建/取消提醒：立即刷新未读快照（pending 列表/灰灯数字不用等下一轮）
      if (
        data.code === 'reminder_created' ||
        data.code === 'reminder_cancelled' ||
        data.code === 'reminder_error'
      ) {
        refreshUnread()
        if (viewMode === 'today') refreshHistory()
      }
    }),
    client.on('config', (config) => {
      const value = (
        config as { reminders?: { os_notification_when_hidden?: unknown } }
      ).reminders?.os_notification_when_hidden
      if (typeof value === 'boolean') notifyWhenHidden = value
    }),
    client.onStateChange((state) => {
      if (state !== 'connected') return
      refreshUnread()
      if (viewMode === 'today') refreshHistory()
    })
  ]

  const speechBridge = bridgeApi()?.bubble
  const offSpeech =
    typeof speechBridge?.onSpeechEvent === 'function'
      ? speechBridge.onSpeechEvent(onSpeechEvent)
      : () => {}
  const reminderListBridge = listBridge()
  const offListAction =
    typeof reminderListBridge?.onAction === 'function'
      ? reminderListBridge.onAction(onListAction)
      : () => {}

  const onVisibilityChange = (): void => {
    if (!hiddenNow()) void flush()
    schedulePublish(0)
  }
  document.addEventListener('visibilitychange', onVisibilityChange)

  if (client.connectionState === 'connected') refreshUnread()

  return () => {
    disposed = true
    offs.forEach((off) => off())
    offSpeech()
    offListAction()
    document.removeEventListener('visibilitychange', onVisibilityChange)
    clearQueueTimer()
    stopPoll()
    if (publishTimer !== null) {
      window.clearTimeout(publishTimer)
      publishTimer = null
    }
    pending = []
    unread = []
    history = []
    historyTotal = 0
    pendingReminders = []
    pendingCount = 0
    pendingExpanded = false
    viewMode = 'unread'
    activeIds = new Set()
    notifiedBatches.clear()
    listBridge()?.update({
      mode: 'unread',
      items: [],
      unreadCount: 0,
      pendingItems: [],
      pendingExpanded: false,
      pendingCount: 0,
      bellOnly: false,
      visible: false
    })
  }
}
