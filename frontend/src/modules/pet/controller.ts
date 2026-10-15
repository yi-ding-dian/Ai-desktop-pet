/**
 * pet 域轻量控制器：模块级单例，向其他域（voice 口型驱动 / 自主行为执行器）暴露宠物渲染能力。
 *
 * 为什么这么做（设计文档 §5.3 "换渲染器不改调用方"的延伸）：
 * - 其他域不应知道渲染器实例/React 挂载细节，也不引入状态库（任务约定：最简方案）；
 * - PetView 挂载渲染器后注册到此，卸载时注销；未挂载期间所有调用都是安全空操作。
 */
import type { Emotion, PetState } from '../../shared/protocol'
import type { PetReactionKind, PetRenderer } from './renderers'

/** dev 态日志（转发到主进程日志，便于无 devtools 验证）；生产构建自动剔除 */
const devLog = (msg: string): void => {
  if (import.meta.env.DEV) console.log(`[pet] ${msg}`)
}

/** 当前挂载中的渲染器（null = 宠物未挂载/已卸载） */
let activeRenderer: PetRenderer | null = null

/** PetView 专用：注册/注销当前活跃渲染器（其余域不要调用） */
export function setActivePetRenderer(renderer: PetRenderer | null): void {
  activeRenderer = renderer
}

/**
 * 设置当前宠物口型开合度（voice 域口型驱动调用；0=闭合 1=全开）。
 * 渲染器未挂载/已释放时静默忽略。
 */
export function setPetMouth(level: number): void {
  activeRenderer?.setMouth(level)
}

/**
 * 设置宠物状态机状态（自主行为执行器调用：walking/sleeping/idle）。
 * 注：对话链路的状态经 WS state 事件直连渲染器（PetView 订阅），不走本函数。
 */
export function setPetState(state: PetState): void {
  activeRenderer?.setState(state)
}

/** 播放一次即时反应（自主行为执行器调用：look_around 张望等） */
export function playPetReaction(kind: PetReactionKind): void {
  activeRenderer?.playReaction(kind)
}

// ------------------------------------------------------------------ 情绪自动回落

/**
 * 情绪自动回落时长（毫秒；0 = 不回落）。
 *
 * 设计：情绪是"表情"而非常驻状态——事件驱动的情绪挂 N 秒后平滑淡回 neutral
 * （渲染器姿态为阻尼追踪，切目标值即自然过渡，无需额外动画）。
 * 分档原则：高唤醒短（一笑即过）、低唤醒长（情绪残留感）。
 */
export const EMOTION_FALLBACK_MS: Record<Emotion, number> = {
  neutral: 0,
  happy: 2_000, // 用户定：点击摸头后蹦 2s 就够了
  surprised: 4_000,
  angry: 6_000,
  sad: 10_000,
  shy: 8_000,
  sleepy: 10_000,
  thinking: 8_000
}

/** 回落到该状态（渲染器白名单外的情绪由渲染器自行兜底为 neutral） */
const FALLBACK_EMOTION = 'neutral'
const FALLBACK_INTENSITY = 1

let fallbackTimer: number | null = null
/** 最近一次情绪事件对应的回落时长（0 = 无需回落；对话中到达的情绪会在对话结束后用它起算） */
let pendingFallbackMs = 0
/** "对话/说话进行中"信号（App 装配层转发，见 setPetConversationActive） */
let conversationActive = false

/**
 * 设置宠物情绪（WS emotion 事件入口；PetView 调用）。
 *
 * 与渲染器 setEmotion 的差别：本函数叠加"自动回落"策略——挂
 * EMOTION_FALLBACK_MS[emotion] 后淡回 neutral；对话/说话进行中则挂起，说完再起算。
 * 注：dev 调试键（PetView 数字 1–8）直连渲染器、不经过本函数——便于定格检查表情。
 */
export function setPetEmotion(emotion: string, intensity = 1): void {
  activeRenderer?.setEmotion(emotion, intensity)
  pendingFallbackMs = EMOTION_FALLBACK_MS[emotion as Emotion] ?? 0
  scheduleEmotionFallback()
}

/**
 * 对话/说话进行中信号（App 装配层调用；信号 = WS state thinking/speaking
 * 或本地语音播放中——后端推 idle 时只是"帧发完"，嗓子可能还在响）。
 *
 * 语义（用户确认）：LLM 回复时就相当于"正在跟你说话"，情绪应挂着不回落；
 * 说完（或被唤醒/打断回到待机且闭嘴）才按最近情绪起算倒计时。
 */
export function setPetConversationActive(active: boolean): void {
  if (conversationActive === active) return
  conversationActive = active
  devLog(active ? '对话/说话开始：情绪回落挂起' : '对话/说话结束：情绪回落起算')
  scheduleEmotionFallback()
}

/** 重排回落倒计时：清旧计时器；无需回落/对话中则不起算 */
function scheduleEmotionFallback(): void {
  if (fallbackTimer !== null) {
    window.clearTimeout(fallbackTimer)
    fallbackTimer = null
  }
  if (pendingFallbackMs <= 0 || conversationActive) return
  const ms = pendingFallbackMs
  fallbackTimer = window.setTimeout(() => {
    fallbackTimer = null
    pendingFallbackMs = 0
    activeRenderer?.setEmotion(FALLBACK_EMOTION, FALLBACK_INTENSITY)
    devLog(`情绪回落 -> ${FALLBACK_EMOTION}（挂了 ${ms}ms）`)
  }, ms)
  devLog(`情绪回落倒计时启动：${ms}ms`)
}
