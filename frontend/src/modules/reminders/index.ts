/**
 * 提醒域（2026-10-18，提醒功能 v1）：后端 `proactive{kind:'reminder'}` → 宠物气泡 + 系统通知。
 *
 * 职责边界：
 *  - 后端负责"何时提醒 / 提醒什么"（application/reminder_service.py），前端只负责展示；
 *  - **气泡一定会出**：语音开关只决定是否播放音频帧（voice 域的 audio 播放器），
 *    与气泡展示无关；
 *  - 抑制态（教学 / 设置向导）或宠物隐藏：先补系统通知，并把文案排队——
 *    环境恢复后自动补气泡，不静默丢弃；
 *  - 回复正在流式输出：只排队，不打断当前回复（也不弹系统通知，用户就在屏幕前）。
 *
 * 可见性判定有两条依据：``document.visibilityState``（页面层）与
 * ``window.pet.window.isVisible()``（主进程 BrowserWindow——宠物"躲进托盘"时页面层
 * 不可靠，2026-10-18 补）。
 *
 * 可扩展：`kind` 目前只有 greeting / reminder；新的主动消息类型在 onProactive
 * 里加一个分支即可，推送/抑制/排队底座不变。
 */
import { getPetBridge } from '../../shared/pet-bridge'
import type { WsClient } from '../../shared/ws-client'
import type { ProactiveData } from '../../shared/protocol'
import { speakReminder } from '../chat'

/** 提醒气泡停留时长（ms；主进程 SET_NEXT_SPEECH_TTL 上限 60s） */
const REMINDER_TTL_MS = 60_000
/** 排队重试间隔（ms）：回复结束 / 教学退出 / 宠物重新显示后尽快补气泡 */
const RETRY_MS = 5_000
/** 多条排队提醒之间的展示间隔（ms）：避免前一条刚看到就被下一条覆盖 */
const GAP_MS = 15_000
/** 排队上限（防长时间抑制态内存增长；超出丢最旧的） */
const MAX_PENDING = 5

export interface ReminderOptions {
  /** 抑制判定（教学 / 设置向导中返回 true）：每次现读，闭包捕获的旧状态会漏判 */
  shouldSuppress: () => boolean
}

/** 系统通知的宽容封装（旧 preload 无 system.notify / 浏览器调试时静默跳过） */
function notifySystem(text: string): void {
  try {
    getPetBridge().system?.notify?.('小兔提醒', text)
  } catch {
    /* bridge 缺失：气泡仍是主通道，通知失败不影响提醒 */
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

/**
 * 接线提醒展示（App 挂载时调用一次）。返回取消订阅/清理函数。
 */
export function setupReminders(client: WsClient, options: ReminderOptions): () => void {
  let disposed = false
  /** 等待补气泡的提醒文案（抑制/隐藏/流式期间临时排队） */
  let pending: string[] = []
  let timer: number | null = null
  /** 宠物隐藏/抑制时是否补系统通知（配置 [reminders].os_notification_when_hidden） */
  let notifyWhenHidden = true
  /** 最近一次气泡展示时间（多条提醒同时到达时按 GAP_MS 排队，避免互相覆盖） */
  let lastShownAt = 0

  const offConfig = client.on('config', (config) => {
    const value = (
      config as { reminders?: { os_notification_when_hidden?: unknown } }
    ).reminders?.os_notification_when_hidden
    if (typeof value === 'boolean') notifyWhenHidden = value
  })

  const clearTimer = (): void => {
    if (timer !== null) {
      window.clearTimeout(timer)
      timer = null
    }
  }

  const schedule = (delay: number): void => {
    if (disposed || timer !== null) return
    timer = window.setTimeout(() => {
      timer = null
      void flush()
    }, delay)
  }

  /** 当前是否允许直接弹气泡（非抑制态、页面可见、宠物窗可见） */
  const canShow = async (): Promise<boolean> => {
    if (options.shouldSuppress()) return false
    if (document.visibilityState !== 'visible') return false
    return petVisible()
  }

  /** 环境允许时展示队首提醒；仍被抑制则继续等 */
  const flush = async (): Promise<void> => {
    if (disposed || pending.length === 0) return
    if (!(await canShow())) {
      schedule(RETRY_MS)
      return
    }
    if (disposed || pending.length === 0) return
    // 上一条提醒气泡还在停留期：等够 GAP_MS 再换下一条，避免快速覆盖
    if (lastShownAt > 0) {
      const wait = GAP_MS - (Date.now() - lastShownAt)
      if (wait > 0) {
        schedule(wait)
        return
      }
    }
    const text = pending[0]
    if (!speakReminder(text, REMINDER_TTL_MS)) {
      // 回复正在流式输出：留给 reply_end 后的下一次重试
      schedule(RETRY_MS)
      return
    }
    pending.shift()
    lastShownAt = Date.now()
    console.log(`[reminders] 提醒气泡已展示：${text}`)
    if (pending.length > 0) schedule(GAP_MS)
  }

  const queue = (text: string, delay = RETRY_MS): void => {
    if (pending.length >= MAX_PENDING) pending.shift()
    pending.push(text)
    schedule(delay)
  }

  const handleProactive = async (data: ProactiveData): Promise<void> => {
    const text = (data.text ?? '').trim()
    if (!text) return
    const allowed = await canShow()
    if (disposed) return
    if (!allowed) {
      // 教学/向导/宠物隐藏：系统通知先兜底（配置可关），气泡排队等环境恢复
      if (notifyWhenHidden) notifySystem(text)
      queue(text)
      return
    }
    const sinceLast = Date.now() - lastShownAt
    if (pending.length === 0 && sinceLast >= GAP_MS && speakReminder(text, REMINDER_TTL_MS)) {
      lastShownAt = Date.now()
      console.log(`[reminders] 提醒气泡已展示：${text}`)
      return
    }
    // 流式回复中 / 上一条提醒刚展示：排队，不打断也不互相覆盖
    queue(text, pending.length === 0 ? Math.max(RETRY_MS, GAP_MS - sinceLast) : RETRY_MS)
  }

  const off = client.on('proactive', (data) => {
    if (data.kind !== 'reminder') return // 未来 greeting 等类型在此扩展
    void handleProactive(data)
  })
  const onVisibilityChange = (): void => {
    if (document.visibilityState === 'visible') void flush()
  }
  document.addEventListener('visibilitychange', onVisibilityChange)

  return () => {
    disposed = true
    off()
    offConfig()
    document.removeEventListener('visibilitychange', onVisibilityChange)
    clearTimer()
    pending = []
  }
}
