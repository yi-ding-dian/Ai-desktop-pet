/**
 * ACP `session/update` → 步骤流（纯逻辑，2026-10-23）。
 *
 * 与 Electron 完全解耦，便于单测：输入是一条 ACP update，输出是可渲染的
 * CodingStep 列表。策略：
 * - 文本按“当前消息/思考”累积成一条步骤，避免每个 token 建一条；
 * - 工具调用按 toolCallId 建/更新步骤；
 * - 步骤总数与单条文本都有上限，防止长任务把内存和 IPC 撑爆。
 */
import type { CodingStep, CodingStepKind } from '../ipc/channels'
import type { AcpUpdate } from './acp'

export interface StepStoreOptions {
  /** 最多保留多少条步骤（丢最旧的） */
  maxSteps?: number
  /** 单条 detail 上限（字符） */
  maxDetail?: number
  /** 单条消息/思考文本上限（字符） */
  maxText?: number
  now?: () => number
}

const DEFAULT_MAX_STEPS = 300
const DEFAULT_MAX_DETAIL = 600
const DEFAULT_MAX_TEXT = 4000

function clampText(text: string, limit: number): string {
  if (text.length <= limit) return text
  return `${text.slice(0, limit)}…`
}

/** 从 ACP content 里取纯文本（非 text 块忽略） */
export function contentText(content: unknown): string {
  if (!content || typeof content !== 'object') return ''
  const block = content as Record<string, unknown>
  return block.type === 'text' && typeof block.text === 'string' ? block.text : ''
}

/** 工具状态归一化：ACP 用 pending/in_progress/completed/failed */
export function normalizeToolStatus(raw: unknown): CodingStep['status'] {
  if (raw === 'completed') return 'done'
  if (raw === 'failed') return 'failed'
  return 'running'
}

export class CodingStepStore {
  private steps: CodingStep[] = []
  private readonly maxSteps: number
  private readonly maxDetail: number
  private readonly maxText: number
  private readonly now: () => number
  private seq = 0
  private messageId: string | null = null
  private thoughtId: string | null = null

  constructor(options: StepStoreOptions = {}) {
    this.maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS
    this.maxDetail = options.maxDetail ?? DEFAULT_MAX_DETAIL
    this.maxText = options.maxText ?? DEFAULT_MAX_TEXT
    this.now = options.now ?? Date.now
  }

  reset(): void {
    this.steps = []
    this.messageId = null
    this.thoughtId = null
    this.seq = 0
  }

  list(): CodingStep[] {
    return this.steps.map((step) => ({ ...step }))
  }

  /** 最后一条助手回复的全文（任务总结用） */
  summary(): string {
    for (let index = this.steps.length - 1; index >= 0; index -= 1) {
      const step = this.steps[index]
      if (step.kind === 'message' && step.detail) return step.detail
    }
    return ''
  }

  /** 追加一条系统步骤（开始/等待确认/结束等） */
  addSystem(title: string, detail?: string): void {
    this.addStep('system', title, detail, 'done')
  }

  /** 收起所有 running 的消息/思考步骤（工具调用前、任务结束时） */
  sealStreams(): void {
    if (this.messageId) this.setStatus(this.messageId, 'done')
    if (this.thoughtId) this.setStatus(this.thoughtId, 'done')
    this.messageId = null
    this.thoughtId = null
  }

  /** 消费一条 ACP 更新 */
  apply(update: AcpUpdate): void {
    switch (update.sessionUpdate) {
      case 'agent_message_chunk': {
        const text = contentText(update.content)
        if (!text) return
        if (this.thoughtId) {
          this.setStatus(this.thoughtId, 'done')
          this.thoughtId = null
        }
        this.appendStream('message', text)
        return
      }
      case 'agent_thought_chunk': {
        const text = contentText(update.content)
        if (!text) return
        this.appendStream('thought', text)
        return
      }
      case 'tool_call': {
        this.sealStreams()
        const id = typeof update.toolCallId === 'string' ? update.toolCallId : this.nextId('tool')
        const title = this.toolTitle(update)
        const detail = summarize(update.rawInput, this.maxDetail)
        this.upsertTool(id, title, detail, normalizeToolStatus(update.status))
        return
      }
      case 'tool_call_update': {
        const id = typeof update.toolCallId === 'string' ? update.toolCallId : ''
        if (!id) return
        const existing = this.steps.find((step) => step.id === id)
        const title = typeof update.title === 'string' && update.title
          ? update.title
          : existing?.title ?? '工具调用'
        const detail = update.rawInput === undefined
          ? existing?.detail
          : summarize(update.rawInput, this.maxDetail)
        this.upsertTool(id, title, detail, normalizeToolStatus(update.status))
        return
      }
      case 'plan': {
        const entries = Array.isArray(update.entries) ? update.entries : []
        const lines = entries
          .map((entry) => {
            if (!entry || typeof entry !== 'object') return ''
            const item = entry as Record<string, unknown>
            const text = typeof item.content === 'string' ? item.content : ''
            if (!text) return ''
            return `· ${text}${item.status === 'completed' ? '（已完成）' : ''}`
          })
          .filter(Boolean)
        if (!lines.length) return
        this.addStep('plan', '计划', clampText(lines.join('\n'), this.maxDetail), 'done')
        return
      }
      default:
        return
    }
  }

  // ---------------------------------------------------------------- 内部

  private nextId(prefix: string): string {
    this.seq += 1
    return `${prefix}-${this.seq}`
  }

  private toolTitle(update: AcpUpdate): string {
    if (typeof update.title === 'string' && update.title) return update.title
    if (typeof update.kind === 'string' && update.kind) return `工具调用（${update.kind}）`
    return '工具调用'
  }

  private appendStream(kind: Extract<CodingStepKind, 'message' | 'thought'>, text: string): void {
    const id = kind === 'message' ? this.messageId : this.thoughtId
    if (!id) {
      const newId = this.nextId(kind)
      if (kind === 'message') this.messageId = newId
      else this.thoughtId = newId
      this.addStep(
        kind,
        kind === 'message' ? '编码代理' : '思考中',
        clampText(text, this.maxText),
        'running',
        newId
      )
      return
    }
    const step = this.steps.find((item) => item.id === id)
    if (!step) return
    step.detail = clampText((step.detail ?? '') + text, this.maxText)
  }

  private upsertTool(
    id: string,
    title: string,
    detail: string | undefined,
    status: CodingStep['status']
  ): void {
    const existing = this.steps.find((step) => step.id === id)
    if (existing) {
      existing.title = title
      if (detail !== undefined) existing.detail = detail
      existing.status = status
      return
    }
    this.addStep('tool', title, detail, status, id)
  }

  private addStep(
    kind: CodingStepKind,
    title: string,
    detail: string | undefined,
    status: CodingStep['status'],
    id?: string
  ): void {
    this.steps.push({
      id: id ?? this.nextId(kind),
      kind,
      title: clampText(title, 200),
      ...(detail ? { detail: clampText(detail, this.maxDetail) } : {}),
      status,
      at: this.now()
    })
    if (this.steps.length > this.maxSteps) {
      this.steps.splice(0, this.steps.length - this.maxSteps)
    }
  }

  private setStatus(id: string, status: CodingStep['status']): void {
    const step = this.steps.find((item) => item.id === id)
    if (step) step.status = status
  }
}

/** 把未知参数压成单行摘要（工具步骤展示用） */
export function summarize(raw: unknown, limit = DEFAULT_MAX_DETAIL): string {
  if (raw === undefined || raw === null) return ''
  let text: string
  if (typeof raw === 'string') {
    text = raw
  } else {
    try {
      text = JSON.stringify(raw)
    } catch {
      text = String(raw)
    }
  }
  text = text.replace(/\s+/g, ' ').trim()
  return clampText(text, limit)
}
