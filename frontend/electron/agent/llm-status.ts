/**
 * 当前模型 + DeepSeek 账户余额（2026-10-25）。
 *
 * 只有主进程会轮询（渲染层拿缓存，不直接碰 Key）：
 *  - 每 10 分钟刷新一次；工作窗打开/手动点击可提前刷新；
 *  - 余额只对官方端点可用，后端返回 code/message 说明原因；
 *  - 刷新失败保留上一次成功的余额，界面不会突然变成 —。
 */
import type { AgentLlmStatus } from './types'
import { internalEndpoint } from './internal-api'
import { normalizeThinkingLevel, thinkingLevelsForModel } from './pi'

/** 自动刷新间隔：10 分钟 */
export const LLM_STATUS_REFRESH_MS = 10 * 60 * 1000
/**
 * 本地不可达（后端未就绪）时的重试间隔。
 *
 * 只用于"连不上本地后端"：服务商返回的错误不重试，避免对外部接口轮询过密。
 */
const RETRY_AFTER_ERROR_MS = 15 * 1000
/** 两次请求的最小间隔（防连点） */
const MIN_REQUEST_GAP_MS = 5 * 1000
const REQUEST_TIMEOUT_MS = 15 * 1000

export type LlmStatusListener = (status: AgentLlmStatus) => void

export function emptyLlmStatus(): AgentLlmStatus {
  return {
    model: '',
    configured: false,
    showBalance: false,
    showModel: false,
    showCost: false,
    thinkingLevel: 'high',
    thinkingLevels: [],
    balanceSupported: false,
    currency: '',
    total: null,
    granted: null,
    toppedUp: null,
    updatedAt: 0,
    code: '',
    message: ''
  }
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** 后端响应 → 状态（纯函数，便于推理；失败时保留上一次余额）。 */
export function mergeLlmStatus(
  previous: AgentLlmStatus,
  payload: Partial<AgentLlmStatus>,
  now: number
): AgentLlmStatus {
  const next: AgentLlmStatus = {
    ...previous,
    model: text(payload.model) || previous.model,
    configured: payload.configured === true,
    showBalance: payload.showBalance === true,
    showModel: payload.showModel === true,
    showCost: payload.showCost === true,
    thinkingLevel: text(payload.thinkingLevel) || previous.thinkingLevel,
    balanceSupported: payload.balanceSupported === true,
    code: text(payload.code),
    message: text(payload.message)
  }
  if (!next.balanceSupported) {
    // 没 Key / 自定义端点：旧余额不再代表当前账户，清掉
    next.currency = ''
    next.total = null
    next.granted = null
    next.toppedUp = null
    return next
  }
  const total = numberOrNull(payload.total)
  if (total !== null) {
    next.currency = text(payload.currency) || previous.currency
    next.total = total
    next.granted = numberOrNull(payload.granted)
    next.toppedUp = numberOrNull(payload.toppedUp)
    next.updatedAt = now
  }
  return next
}

export class LlmStatusMonitor {
  private status = emptyLlmStatus()
  private listeners = new Set<LlmStatusListener>()
  private timer: NodeJS.Timeout | null = null
  /** 失败后的补一次（后端可能还没就绪；不必等满 10 分钟） */
  private retryTimer: NodeJS.Timeout | null = null
  private inflight: Promise<AgentLlmStatus> | null = null
  private lastAttempt = 0
  private started = false

  get(): AgentLlmStatus {
    return { ...this.status }
  }

  onStatus(listener: LlmStatusListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** 启动定时刷新（幂等；定时器 unref，不阻塞退出）。 */
  start(): void {
    if (this.started) return
    this.started = true
    void this.refresh(false)
    this.timer = setInterval(() => void this.refresh(false), LLM_STATUS_REFRESH_MS)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.timer = null
    this.retryTimer = null
    this.started = false
  }

  /**
   * 工作窗挂载时调用：缓存够新就直接返回；从未成功或上次失败超过 1 分钟则补一次。
   */
  async ensureFresh(maxAgeMs: number = LLM_STATUS_REFRESH_MS): Promise<AgentLlmStatus> {
    const age = Date.now() - this.lastAttempt
    const stale = this.lastAttempt === 0 || age >= maxAgeMs
    const failedLongAgo = this.status.code !== '' && age >= RETRY_AFTER_ERROR_MS
    if (!stale && !failedLongAgo) return this.get()
    return this.refresh(false)
  }

  /** 刷新（force=false 时 5 秒内不重复请求；手动刷新立即生效）。 */
  async refresh(force = true): Promise<AgentLlmStatus> {
    if (this.inflight) return this.inflight
    const gap = force ? 0 : MIN_REQUEST_GAP_MS
    if (this.lastAttempt > 0 && Date.now() - this.lastAttempt < gap) {
      return this.get()
    }
    this.inflight = this.doRefresh().finally(() => {
      this.inflight = null
    })
    return this.inflight
  }

  private async doRefresh(): Promise<AgentLlmStatus> {
    this.lastAttempt = Date.now()
    try {
      const { url, token } = internalEndpoint('/internal/llm-status')
      const response = await fetch(url, {
        headers: { 'X-Pet-Internal-Token': token },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const payload = (await response.json()) as Partial<AgentLlmStatus>
      const merged = mergeLlmStatus(this.status, payload, Date.now())
      this.status = { ...merged, thinkingLevels: thinkingLevelsForModel(merged.model) }
      this.clearRetry()
    } catch (err) {
      // 后端未就绪/网络错误：保留上次余额，只记录原因
      this.status = {
        ...this.status,
        code: 'unreachable',
        message: '模型/余额状态暂时查不到'
      }
      console.warn('[agent] 模型/余额状态刷新失败：', (err as Error).message)
      this.scheduleRetry()
    }
    this.emit()
    return this.get()
  }

  /** 切换下次新任务的思考强度（写 config.toml [agent].thinking_level）。 */
  async setThinkingLevel(level: string): Promise<{ ok: boolean; error?: string }> {
    const normalized = normalizeThinkingLevel(level)
    try {
      const { url, token } = internalEndpoint('/internal/agent-config')
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Pet-Internal-Token': token
        },
        body: JSON.stringify({ thinkingLevel: normalized }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const data = (await response.json()) as {
        ok?: boolean
        message?: string
        thinkingLevel?: string
      }
      if (!data.ok) throw new Error(data.message || '保存思考强度失败')
      this.status = {
        ...this.status,
        thinkingLevel: normalizeThinkingLevel(data.thinkingLevel ?? normalized)
      }
      this.emit()
      // 顺带刷新余额/模型（配置可能同时变化）；失败不影响这次切换
      void this.refresh(true)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: (err as Error).message || '保存思考强度失败' }
    }
  }

  private scheduleRetry(): void {
    if (this.retryTimer || !this.started) return
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      void this.refresh(false)
    }, RETRY_AFTER_ERROR_MS)
    this.retryTimer.unref?.()
  }

  private clearRetry(): void {
    if (!this.retryTimer) return
    clearTimeout(this.retryTimer)
    this.retryTimer = null
  }

  private emit(): void {
    for (const listener of this.listeners) {
      try {
        listener(this.get())
      } catch (err) {
        console.error('[agent] 模型/余额状态推送失败：', (err as Error).message)
      }
    }
  }
}

export const llmStatusMonitor = new LlmStatusMonitor()
