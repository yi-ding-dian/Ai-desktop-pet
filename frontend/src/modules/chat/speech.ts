/**
 * 说话气泡驱动（chat 域）：把对话事件流翻译成气泡窗指令（宠物面 → 主进程 bubble 域），
 * 聊天回复从"底部消息列表"改为"兔子头部旁的说话气泡"（2026-10-16 用户定稿）。
 *
 * 为什么在 chat 域：它是**对话的展示通道**——订阅的事件（reply_start/token/reply_end/error）
 * 与消息列表时期完全一致，只是出口从 DOM 换成气泡窗。气泡怎么摆/怎么收在主进程 bubble 域
 * （哑渲染面不认识聊天业务），本模块只负责：
 *  - 事件翻译：reply_start → sayBegin；token → sayText（全文快照 + 节流）；reply_end → sayEnd
 *    （interrupted 时 immediate 打断即收）；error → 简短错误气泡（无活跃回复时）；
 *  - 节流：token 频率可能远超帧率——TEXT_THROTTLE_MS 定时窗口合并（最后一次快照为准，
 *    全文覆盖式），文字平滑跟上同时不打爆 IPC；reply_end 的 full_text 是权威终稿，绕过节流直发；
 *  - 抑制：教学模式/设置向导中不弹（各自有气泡体系：黑板镜像/萌语气泡）——调用方（App 接线层）
 *    传入 shouldSuppress 判定，本模块不直接依赖 teaching/settings-guide 域（低耦合）。
 *
 * 容错：bridge 缺失（浏览器直开调试）时静默降级为无气泡（对话其余链路不受影响）。
 */
import { getPetBridge } from '../../shared/pet-bridge'
import type { PetBridgeApi } from '../../../electron/ipc/channels'
import type { WsClient } from '../../shared/ws-client'

/** 文本快照节流窗口（ms）：窗口内多次 token 合并为一次全文下发 */
const TEXT_THROTTLE_MS = 100

/** dev 态日志（转发到主进程日志，便于无 devtools 验证）；生产构建自动剔除 */
const devLog = (msg: string): void => {
  if (import.meta.env.DEV) console.log(`[chat] ${msg}`)
}

/** 宽容取 bubble 段：bridge 缺失（浏览器直开调试）时返回 undefined（静默降级） */
function bubbleBridge(): PetBridgeApi['bubble'] | undefined {
  try {
    return getPetBridge().bubble
  } catch {
    return undefined
  }
}

export interface SpeechBubbleOptions {
  /** 抑制判定（教学/向导中返回 true）：每次事件现读——闭包捕获的旧状态会漏判 */
  shouldSuppress: () => boolean
}

/** 本轮回复是否流式中（reply_start → reply_end） */
let speechActive = false
/** 最近一次真实回复的正文（回复气泡是常驻的——非空时本地短提示不要覆盖它） */
let speechLatest = ''
/** 本地短提示的自动收起定时器（5s 后 sayEnd(true)） */
let transientTimer: number | null = null

function clearTransientTimer(): void {
  if (transientTimer !== null) {
    window.clearTimeout(transientTimer)
    transientTimer = null
  }
}

/**
 * 宠物说一句**本地短提示**（如"不支持这个文件类型"），ttlMs 后自动收起。
 *
 * 为什么不直接复用回复气泡：
 * - 回复气泡是常驻的（用户定稿"回复的消息不要消失"），本地提示不能把常驻回复覆盖掉；
 * - 有回复流式/常驻时返回 false，调用方改用聊天区 notice（同样 5s 消失）。
 * 本地提示显示期间若真实回复开始，``begin()`` 会清掉这里的定时器，避免把新回复误收。
 */
export function speakLocalNotice(text: string, ttlMs = 5_000): boolean {
  const bridge = bubbleBridge()
  if (!bridge || typeof bridge.sayBegin !== 'function') return false
  if (speechActive || speechLatest) return false
  clearTransientTimer()
  // 新主进程：5s 计时交给气泡域（同样受悬浮/选区/右键菜单暂停，复制/阅读时不会被 5s 硬收）
  if (typeof bridge.setNextSpeechTtl === 'function') {
    bridge.setNextSpeechTtl(ttlMs)
    bridge.sayBegin()
    bridge.sayText(text)
    bridge.sayEnd(false)
    return true
  }
  // 旧主进程兜底：渲染侧硬计时 5s 后强制收
  bridge.sayBegin()
  bridge.sayText(text)
  bridge.sayEnd(false)
  transientTimer = window.setTimeout(() => {
    transientTimer = null
    bridge.sayEnd(true)
  }, ttlMs)
  return true
}

/**
 * 宠物主动说一句**提醒**（提醒功能 v1，2026-10-18）：气泡一定会出，与语音开关无关。
 *
 * 与 ``speakLocalNotice`` 的区别：提醒优先级更高——即使当前已有常驻回复气泡，
 * 也用提醒文本原地替换（用户刚看到的回复已经读过；下一轮回复会再次替换回来）。
 * 唯一让位场景是**回复正在流式输出**（speechActive）：此时返回 false，调用方
 * 排队等 reply_end 后再展示，避免把正在生成的回复打断。
 */
export function speakReminder(text: string, ttlMs = 60_000): boolean {
  const bridge = bubbleBridge()
  if (!bridge || typeof bridge.sayBegin !== 'function') return false
  if (speechActive) return false
  clearTransientTimer()
  if (typeof bridge.setNextSpeechTtl === 'function') {
    bridge.setNextSpeechTtl(ttlMs) // 主进程夹取上限 60s；提醒建议停留 60s
  }
  bridge.sayBegin()
  bridge.sayText(text)
  bridge.sayEnd(false)
  speechLatest = text
  return true
}

/**
 * 接线说话气泡驱动（App 在挂载时调用一次）。返回取消订阅函数。
 */
export function setupSpeechBubble(client: WsClient, options: SpeechBubbleOptions): () => void {
  const bridge = bubbleBridge()
  // 兼容旧 preload（无 sayBegin 三件套——主进程重启前过渡态）与无 bridge（浏览器直开调试）：静默跳过
  if (!bridge || typeof bridge.sayBegin !== 'function') {
    devLog('bubble bridge 不支持说话气泡，静默跳过（其余对话链路不受影响）')
    return () => {}
  }

  let flushTimer: number | null = null

  const clearFlush = (): void => {
    if (flushTimer !== null) {
      window.clearTimeout(flushTimer)
      flushTimer = null
    }
  }

  const begin = (): void => {
    speechActive = true
    speechLatest = ''
    clearTransientTimer() // 真实回复接管：别让本地短提示的 5s 定时器把新回复收掉
    clearFlush()
    bridge.sayBegin()
  }

  /** 结束本轮说话：finalText（reply_end 的权威终稿，可为空串）直发绕过节流；immediate = 被打断 */
  const end = (finalText: string, immediate: boolean): void => {
    if (!speechActive) return
    speechActive = false
    clearFlush()
    const text = finalText || speechLatest
    if (text) bridge.sayText(text)
    bridge.sayEnd(immediate)
    // immediate 气泡会收起；非 immediate 气泡常驻（本地短提示不要覆盖）
    speechLatest = immediate ? '' : text
  }

  const offs = [
    client.on('reply_start', () => {
      if (options.shouldSuppress()) return
      begin()
    }),
    client.on('token', ({ text }) => {
      if (!speechActive) return
      speechLatest += text
      if (flushTimer === null) {
        // 定时窗口合并：首 token 立即发一次（气泡不空等），窗口内后续合并到下一次
        bridge.sayText(speechLatest)
        flushTimer = window.setTimeout(() => {
          flushTimer = null
          if (speechActive) bridge.sayText(speechLatest)
        }, TEXT_THROTTLE_MS)
      }
    }),
    client.on('reply_end', ({ full_text, interrupted }) => {
      end(full_text, Boolean(interrupted))
    }),
    client.on('error', ({ code, message }) => {
      // 错误提示走气泡（错误发生时无活跃回复——后端错误即本轮失败，reply_end 未必到达）：
      // begin + text + end 连着发；主进程侧气泡弹出就绪期已能承接"先文本后结束"的时序
      if (speechActive || options.shouldSuppress()) return
      clearTransientTimer()
      devLog(`错误气泡：${code} ${message}`)
      speechLatest = `⚠ ${code}: ${message}`
      bridge.sayBegin()
      bridge.sayText(speechLatest)
      bridge.sayEnd(false)
    })
  ]
  return () => {
    offs.forEach((off) => off())
    clearFlush()
    clearTransientTimer()
    speechActive = false
    speechLatest = ''
  }
}

/**
 * 收起正在显示的说话气泡（教学/向导进入时由 App 接线层调用）：
 * sayEnd(immediate) 语义 = "中止本轮说话展示"——无论会话是否已结束（含停留期），
 * 只要窗里是说话气泡就立即收（主进程 endSpeechBubble(immediate) 承担判定）。
 */
export function dismissSpeechBubble(): void {
  clearTransientTimer()
  speechActive = false
  speechLatest = ''
  bubbleBridge()?.sayEnd(true)
}
