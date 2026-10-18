/**
 * 启动称呼引导（2026-10-18，chat 域）：画像里还没有用户名字时，在启动问候收尾后
 * 问一句"你好呀~你叫什么名字呢？"。
 *
 * 用户定稿的方案：
 *  - 名字存**用户画像**（后端 profile 的「称呼」），不占记忆本条目；
 *  - 回答交给**正常对话链路**：LLM 回复 + 后台记忆提取写入画像（本模块不截获、不直存）；
 *  - 每次启动最多问一次；用户明确拒绝 → 本地冷却 7 天；回答过 → 24h 内不再问
 *    （给后台提取留时间，避免快速重启时重复追问）。
 *
 * 为什么要把提问补录到后端（note_assistant_message）：
 * 问候/提问是宠物面**本地气泡**，LLM 看不到；只发提问不补录，用户回一句"小明"
 * 在模型看来就是没头没尾的家常话。补录后 LLM 与后台记忆提取都拿到了上下文。
 *
 * 时序：lifecycle.onSay(greeting) → 问候气泡 TTL(3s) + 收尾 → 查画像 → 提问。
 * 所有状态都在渲染进程内存 + localStorage（冷却），不进后端配置。
 */
import { getPetBridge } from '../../shared/pet-bridge'
import type { ProfileData } from '../../shared/protocol'
import type { WsClient, WsConnectionState } from '../../shared/ws-client'
import { speakLifecycleLine } from './speech'

/** 提问文案（同时补录进会话历史，前后必须一致） */
const PROMPT_TEXT = '你好呀~你叫什么名字呢？'
/** 提问气泡停留（ms；够用户看清并开始输入；悬浮时气泡域会暂停自动收起） */
const PROMPT_TTL_MS = 20_000
/** 问候气泡 TTL（3s）之后再多等一点，保证"我来了~"先说完 */
const PROMPT_DELAY_AFTER_GREETING_MS = 3_600
/** 画像查询超时（ms；旧后端没有 get_profile 时静默放弃） */
const PROFILE_QUERY_TIMEOUT_MS = 3_000
/** 等待 WS 连接的上限（ms；后端没起来就不问） */
const CONNECT_WAIT_MS = 15_000
/** 提问后的"回答窗口"（ms）：超时后的发言不再按回答处理 */
const ANSWER_WINDOW_MS = 60_000
/** 明确拒绝后的冷却（ms） */
const SNOOZE_REFUSAL_MS = 7 * 24 * 60 * 60 * 1000
/** 回答过（或已跳过）后的防重复冷却（ms）：给后台记忆提取留时间 */
const ANSWERED_COOLDOWN_MS = 24 * 60 * 60 * 1000
/** 兜底检查延迟（ms；没收到 greeting 事件时——旧主进程/旧 preload——也问一次） */
const FALLBACK_CHECK_MS = 12_000

const SNOOZE_KEY = 'pet.namePrompt.snoozedUntil'
const ANSWERED_KEY = 'pet.namePrompt.answeredAt'

/** 明确的拒绝语义（"不叫 X"不算拒绝——那是在给名字，交给 LLM 处理） */
const REFUSAL_RE = /不想(说|告诉|透露)|不方便(说|告诉)|算了|别问|保密|以后再(说|告诉)|不告诉你/

// ------------------------------------------------------------------ 模块状态

/** 本次启动是否已经问过（之后不再问） */
let askedThisSession = false
/** 提问后是否在等用户下一条消息 */
let awaitingAnswer = false
/** 回答窗口截止时间（ms） */
let awaitingUntil = 0
/** 本次启动用户是否已经发过消息（发过就不再打扰） */
let userHasChatted = false
/** 检查/提问进行中（防主路径与兜底定时器并发问两次） */
let checking = false

// ------------------------------------------------------------------ 本地冷却（localStorage）

function readStamp(key: string): number {
  try {
    const value = Number(window.localStorage.getItem(key) ?? 0)
    return Number.isFinite(value) ? value : 0
  } catch {
    return 0
  }
}

function writeStamp(key: string, value: number): void {
  try {
    window.localStorage.setItem(key, String(value))
  } catch {
    // 隐私模式/存储不可用：退化为"每次都问"，不影响主链路
  }
}

// ------------------------------------------------------------------ WS 小工具

/** 等 WS 连接就绪（已就绪立即返回 true；超时 false） */
function waitConnected(client: WsClient, timeoutMs: number): Promise<boolean> {
  if (client.connectionState === 'connected') return Promise.resolve(true)
  return new Promise((resolve) => {
    let done = false
    let timer: number | null = null
    let off: (() => void) | null = null
    const finish = (ok: boolean): void => {
      if (done) return
      done = true
      if (timer !== null) window.clearTimeout(timer)
      off?.()
      resolve(ok)
    }
    off = client.onStateChange((state: WsConnectionState) => {
      if (state === 'connected') finish(true)
    })
    timer = window.setTimeout(() => finish(false), timeoutMs)
  })
}

/** 拉取画像摘要（get_profile → profile；超时/旧后端返回 null） */
function requestProfile(client: WsClient): Promise<ProfileData | null> {
  return new Promise((resolve) => {
    let done = false
    let timer: number | null = null
    let off: (() => void) | null = null
    const finish = (data: ProfileData | null): void => {
      if (done) return
      done = true
      if (timer !== null) window.clearTimeout(timer)
      off?.()
      resolve(data)
    }
    off = client.on('profile', (data) => finish(data))
    timer = window.setTimeout(() => finish(null), PROFILE_QUERY_TIMEOUT_MS)
    if (!client.send('get_profile', {})) finish(null)
  })
}

// ------------------------------------------------------------------ 提问

/** 真正的检查流程（由 maybePrompt 的并发闸门包住） */
async function runPromptCheck(
  client: WsClient,
  shouldSuppress: () => boolean,
  isDisposed: () => boolean
): Promise<void> {
  if (askedThisSession || userHasChatted) return
  if (shouldSuppress()) return
  if (Date.now() < readStamp(SNOOZE_KEY)) {
    console.log('[onboarding] 称呼提问处于冷却期（用户此前拒绝过），跳过')
    return
  }
  if (Date.now() - readStamp(ANSWERED_KEY) < ANSWERED_COOLDOWN_MS) {
    console.log('[onboarding] 近期已问过称呼（等待后台记忆提取落库），跳过')
    return
  }
  if (!(await waitConnected(client, CONNECT_WAIT_MS))) {
    console.log('[onboarding] 后端未连接，跳过称呼提问')
    return
  }
  if (isDisposed() || askedThisSession || userHasChatted || shouldSuppress()) return

  const profile = await requestProfile(client)
  if (isDisposed()) return
  if (profile === null) {
    console.log('[onboarding] 画像查询超时/旧后端不支持，跳过称呼提问')
    return
  }
  if (profile.has_name) return
  if (profile.memory_enabled === false) {
    // 记忆提取关闭 → 名字不会被自动写入画像，问了也存不上
    console.log('[onboarding] 后台记忆提取未开启，跳过称呼提问')
    return
  }
  if (askedThisSession || userHasChatted || shouldSuppress()) return

  // 提问补录进会话历史（LLM/记忆提取的回答上下文）——失败就不提，避免"问了模型听不懂"
  if (!client.send('note_assistant_message', { text: PROMPT_TEXT })) {
    console.log('[onboarding] 提问补录发送失败，跳过称呼提问')
    return
  }

  if (!speakLifecycleLine(PROMPT_TEXT, { ttlMs: PROMPT_TTL_MS })) {
    console.log('[onboarding] 说话气泡不可用，跳过称呼提问')
    return
  }
  askedThisSession = true
  awaitingAnswer = true
  awaitingUntil = Date.now() + ANSWER_WINDOW_MS
  console.log('[onboarding] 画像无称呼 → 询问用户名字')
}

/**
 * 查画像并决定是否提问。幂等：本次启动已问过/用户已发言/处于教学/向导中 → 直接返回。
 * 并发闸门：主路径（问候事件）与兜底定时器可能同时触发，只允许一个检查在途。
 */
async function maybePrompt(
  client: WsClient,
  shouldSuppress: () => boolean,
  isDisposed: () => boolean
): Promise<void> {
  if (checking) return
  checking = true
  try {
    await runPromptCheck(client, shouldSuppress, isDisposed)
  } finally {
    checking = false
  }
}

// ------------------------------------------------------------------ 对外

/**
 * 用户发出一条聊天消息（ChatPanel 在校验/发送成功后调用）。
 *
 * 只做两件事：
 *  - 记录"本次启动已发言"（晚到的提问不再打扰）；
 *  - 若正处在提问后的回答窗口：识别明确拒绝 → 7 天冷却；其余视为已回应 →
 *    24h 内不再问（名字本身交给 LLM/后台提取，本模块不解析、不落库）。
 */
export function notifyUserMessage(text: string): void {
  userHasChatted = true
  if (!awaitingAnswer) return
  awaitingAnswer = false
  const trimmed = (text || '').trim()
  if (!trimmed) return
  if (Date.now() > awaitingUntil) return // 回答窗口已过：不按回答/拒绝处理
  if (REFUSAL_RE.test(trimmed)) {
    writeStamp(SNOOZE_KEY, Date.now() + SNOOZE_REFUSAL_MS)
    console.log('[onboarding] 用户拒绝告知称呼 → 7 天内不再问')
    return
  }
  writeStamp(ANSWERED_KEY, Date.now())
  console.log('[onboarding] 用户在称呼提问后发言 → 24h 内不再问（等待记忆提取）')
}

/**
 * 接线启动称呼引导（App 挂载时调用一次）。返回清理函数。
 *
 * StrictMode 双调用安全：模块状态在入口重置，旧实例的定时器/订阅在清理时释放；
 * 在途异步检查用 disposed 标志拦截回写。
 */
export function setupNameOnboarding(
  client: WsClient,
  options: { shouldSuppress: () => boolean }
): () => void {
  askedThisSession = false
  awaitingAnswer = false
  awaitingUntil = 0
  userHasChatted = false
  checking = false

  let disposed = false
  let timer: number | null = null
  const isDisposed = (): boolean => disposed

  const schedule = (delayMs: number): void => {
    if (disposed) return
    if (timer !== null) window.clearTimeout(timer)
    timer = window.setTimeout(() => {
      timer = null
      void maybePrompt(client, options.shouldSuppress, isDisposed)
    }, delayMs)
  }

  // 主路径：等启动问候（"我来了~"）收尾
  let offSay: (() => void) | null = null
  try {
    offSay =
      getPetBridge().lifecycle?.onSay?.(({ kind }) => {
        if (kind === 'greeting') schedule(PROMPT_DELAY_AFTER_GREETING_MS)
      }) ?? null
  } catch {
    offSay = null // 旧 preload / 浏览器直开调试：走兜底
  }

  // 兜底：没收到 greeting 事件（旧主进程/动画降级仍会发；这里只防极端情况）
  const fallback = window.setTimeout(() => schedule(0), FALLBACK_CHECK_MS)

  return () => {
    disposed = true
    if (timer !== null) window.clearTimeout(timer)
    timer = null
    window.clearTimeout(fallback)
    offSay?.()
    awaitingAnswer = false
  }
}
