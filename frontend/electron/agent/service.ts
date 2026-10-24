/**
 * 任务模式服务（2026-10-23）：多任务的完整生命周期。
 *
 * 职责：
 *  - 校验工作区 → 向后端内部端点取聊天 Key → 建 pi-agent-core Agent；
 *  - 每个任务一个 Session：步骤、待办、确认卡、Agent 上下文各自独立；
 *  - 把 Agent 事件流翻译成面板步骤，节流推给渲染层；
 *  - 写文件 / 改文件 / 跑命令前弹确认（beforeToolCall），拒绝即阻断；
 *  - 中止、超时、审计、错误脱敏；任务记录落盘，重启后可回看。
 *
 * 并发约定：同一时间只允许一个任务运行（runningId）；其它任务可停在结束态并随意切换。
 *
 * 目录分工：session（会话模型与常量）/ attachments / events（事件翻译）/
 * llm-key / store（落盘）。
 */
import { randomUUID } from 'node:crypto'
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import type { ImageContent } from '@earendil-works/pi-ai'
import { buildAgent } from './pi'
import { createTools, describeToolCall, needsApproval, type ApprovalDescription } from './tools'
import { resolveWorkspace } from './workspace'
import { loadSessions, saveSessions, type PersistedSession, type PersistedState } from './store'
import { buildPrompt, normalizeAttachments } from './attachments'
import { AgentEventTranslator } from './events'
import { fetchLlmKey } from './llm-key'
import {
  APPROVAL_TIMEOUT_MS,
  MAX_LIVE_AGENTS,
  PUSH_THROTTLE_MS,
  SAVE_DEBOUNCE_MS,
  TASK_TIMEOUT_MS,
  createSession,
  emptyState,
  restoreSession,
  sanitizeError,
  type Session,
  type StateListener,
  type TasksListener
} from './session'
import type {
  AgentApprovalRequest,
  AgentAttachment,
  AgentFollowUpPayload,
  AgentStartPayload,
  AgentState,
  AgentTaskSummary
} from './types'

export class AgentService {
  private sessions = new Map<string, Session>()
  private activeId: string | null = null
  /** 正在运行的任务（全局只允许一个） */
  private runningId: string | null = null
  private stateListeners = new Set<StateListener>()
  private tasksListeners = new Set<TasksListener>()
  private pushTimer: NodeJS.Timeout | null = null
  private saveTimer: NodeJS.Timeout | null = null
  private loaded = false
  /** 当前模型（面板副标题用） */
  private modelId = ''
  /** Agent 事件 → 步骤（思考/回复/工具/待办） */
  private readonly translator = new AgentEventTranslator({
    touch: (session) => this.touch(session),
    audit: (event, data) => this.audit(event, data)
  })

  // ---------------- 对外 API ----------------

  onState(listener: StateListener): () => void {
    this.stateListeners.add(listener)
    return () => this.stateListeners.delete(listener)
  }

  onTasks(listener: TasksListener): () => void {
    this.tasksListeners.add(listener)
    return () => this.tasksListeners.delete(listener)
  }

  /** 当前任务状态（没有任务时返回空态） */
  getState(): AgentState {
    this.ensureLoaded()
    const session = this.activeSession()
    return session ? session.state : emptyState()
  }

  /** 左侧列表（按更新时间倒序） */
  listTasks(): AgentTaskSummary[] {
    this.ensureLoaded()
    return [...this.sessions.values()]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((session) => ({
        id: session.state.id,
        task: session.state.task,
        workspace: session.state.workspace,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        status: session.state.status
      }))
  }

  /** 切换当前任务 */
  select(id: string): { ok: boolean; error?: string } {
    this.ensureLoaded()
    if (!this.sessions.has(id)) return { ok: false, error: '任务不存在' }
    this.activeId = id
    this.flush()
    this.scheduleSave()
    return { ok: true }
  }

  /** 删除一个任务（运行中的先中止）；删掉当前任务后自动切到最近的一条 */
  deleteTask(id: string): { ok: boolean; error?: string } {
    this.ensureLoaded()
    const session = this.sessions.get(id)
    if (!session) return { ok: false, error: '任务不存在' }

    if (session.running) {
      this.clearTaskTimer(session)
      session.agent?.abort()
      this.resolveApproval(session, false)
      session.agent = null
      session.running = false
      if (this.runningId === id) this.runningId = null
    }
    this.sessions.delete(id)
    this.audit('delete', { id })
    if (this.activeId === id) {
      const next = [...this.sessions.values()].sort((a, b) => b.updatedAt - a.updatedAt)[0]
      this.activeId = next ? next.state.id : null
    }
    this.flush()
    this.pushTasks()
    this.scheduleSave()
    return { ok: true }
  }

  /** 开始新任务：校验通过即返回，真正的执行在后台跑 */
  start(payload: AgentStartPayload): { ok: boolean; error?: string } {
    this.ensureLoaded()
    if (this.runningId) return { ok: false, error: '已有任务在跑，先中止或等它结束' }
    const task = (payload?.task ?? '').trim()
    if (!task) return { ok: false, error: '任务描述不能为空' }
    if (task.length > 2000) return { ok: false, error: '任务描述过长（上限 2000 字）' }

    let workspace: string
    try {
      workspace = resolveWorkspace(payload?.workspace ?? '')
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }

    const attachments = normalizeAttachments(payload?.attachments)
    const id = randomUUID()
    const now = Date.now()
    const session: Session = createSession(id, task, workspace, now)
    session.attachmentPaths.push(...attachments.map((item) => item.path))
    session.roundStartedAt = now
    session.roundCalls = 0
    session.roundInput = 0
    session.roundOutput = 0
    session.roundCache = 0
    this.sessions.set(id, session)
    this.activeId = id
    this.runningId = id
    this.push(true)
    this.pushTasks()
    this.scheduleSave()
    void this.runTask(session, task, workspace, attachments)
    return { ok: true }
  }

  /**
   * 继续追问：作用于**当前任务**，沿用同一个 Agent（带上下文）。
   *
   * 任务正常结束/失败后可用；中止或应用重启后不可用。
   */
  followUp(payload: AgentFollowUpPayload | string): { ok: boolean; error?: string } {
    this.ensureLoaded()
    const session = this.activeSession()
    if (!session) return { ok: false, error: '还没有任务，先开始一个' }
    if (!session.agent) {
      return { ok: false, error: '这个任务的上下文已释放（应用重启或超出保留数），点「新任务」重新开始' }
    }
    const text = typeof payload === 'string' ? payload : (payload?.text ?? '')
    const trimmed = text.trim()
    if (!trimmed) return { ok: false, error: '内容不能为空' }
    if (trimmed.length > 2000) return { ok: false, error: '内容过长（上限 2000 字）' }

    const attachments = normalizeAttachments(
      typeof payload === 'string' ? [] : payload?.attachments
    )
    for (const item of attachments) {
      if (!session.attachmentPaths.includes(item.path)) session.attachmentPaths.push(item.path)
    }
    const prompt = buildPrompt(trimmed, attachments)

    session.round += 1
    this.translator.pushStep(session, {
      id: `round-${session.round}`,
      kind: 'round',
      title: trimmed,
      status: 'done',
      startedAt: Date.now(),
      endedAt: Date.now()
    })
    this.audit('follow-up', {
      id: session.state.id,
      text: trimmed.slice(0, 200),
      attachments: attachments.length,
      steer: session.running
    })

    if (session.running) {
      // 运行中：作为插话交给 steering 队列，当前工具批次结束后注入
      session.agent.steer({
        role: 'user',
        content: [{ type: 'text', text: prompt.text }, ...prompt.images],
        timestamp: Date.now()
      })
      return { ok: true }
    }
    if (this.runningId && this.runningId !== session.state.id) {
      return { ok: false, error: '另一个任务正在运行，等它结束再发' }
    }

    session.roundStartedAt = Date.now()
    session.roundCalls = 0
    session.roundInput = 0
    session.roundOutput = 0
    session.roundCache = 0
    session.running = true
    this.runningId = session.state.id
    session.state.status = 'running'
    session.state.summary = undefined
    session.state.error = undefined
    session.state.endedAt = undefined
    session.state.approval = undefined
    void this.executeTurn(session, prompt.text, prompt.images)
    return { ok: true }
  }

  /** 中止当前任务：关掉 Agent、拒掉在途确认、清理定时器 */
  cancel(reason: 'user' | 'timeout' = 'user'): void {
    const session = this.activeSession()
    if (!session || !session.running) return
    this.clearTaskTimer(session)
    session.agent?.abort()
    this.resolveApproval(session, false)
    session.state.approval = undefined
    session.state.status = 'cancelled'
    session.state.endedAt = Date.now()
    session.state.error = reason === 'timeout' ? '任务超过 30 分钟上限，已自动中止' : undefined
    session.running = false
    if (this.runningId === session.state.id) this.runningId = null
    // 被 abort 的 Agent 不能续跑：清掉，继续聊需要重新开始任务
    session.agent = null
    this.audit('cancel', { id: session.state.id, reason })
    this.push(true)
    this.pushTasks()
    this.scheduleSave()
  }

  /** 用户对确认卡的选择（按 pending id 找所属任务，可能在后台任务上） */
  respondApproval(id: string, allow: boolean): void {
    for (const session of this.sessions.values()) {
      const pending = session.pending
      if (!pending || pending.id !== id) continue
      this.resolveApproval(session, allow)
      session.state.approval = undefined
      if (session.state.status === 'waiting') session.state.status = 'running'
      this.audit('approval', { id: session.state.id, approvalId: id, allow })
      if (session.state.id === this.activeId) this.push(true)
      return
    }
  }

  // ---------------- 执行 ----------------

  private async runTask(
    session: Session,
    task: string,
    workspace: string,
    attachments: AgentAttachment[]
  ): Promise<void> {
    try {
      const key = await fetchLlmKey()
      const tools = createTools({
        workspace,
        // 数组原地追加：后续追问附上的文件也能被 read_file 读到
        extraReadPaths: session.attachmentPaths,
        onTodo: (items) => this.translator.applyTodo(session, items)
      })

      const built = buildAgent({
        apiKey: key.key,
        baseUrl: key.baseUrl,
        model: key.model,
        tools,
        beforeToolCall: async ({ toolCall, args }) => {
          if (!needsApproval(toolCall.name)) return undefined
          const desc = describeToolCall(toolCall.name, args, workspace)
          const allowed = await this.askApproval(session, toolCall.name, desc)
          if (allowed) return undefined
          return {
            block: true,
            reason: '用户拒绝了这次操作。不要原样重试，换方案或停下来问用户。'
          }
        }
      })

      session.agent = built.agent
      this.modelId = built.modelId
      session.state.context = { used: 0, window: built.contextWindow }
      session.agent.subscribe((event) => this.translator.onAgentEvent(session, event))
      this.audit('start', {
        id: session.state.id,
        task,
        workspace,
        model: this.modelId,
        attachments: attachments.length
      })
      const prompt = buildPrompt(task, attachments)
      await this.executeTurn(session, prompt.text, prompt.images)
    } catch (err) {
      // 走到这里只可能是准备阶段失败（取 Key / 建 Agent）
      if (session.state.status === 'cancelled') return
      session.state.status = 'failed'
      session.state.error = sanitizeError((err as Error)?.message ?? String(err))
      session.state.endedAt = Date.now()
      session.agent = null
      session.running = false
      if (this.runningId === session.state.id) this.runningId = null
      this.audit('failed', { id: session.state.id, error: session.state.error })
      this.push(true)
      this.pushTasks()
      this.scheduleSave()
      this.clearTaskTimer(session)
    }
  }

  /** 跑一轮对话：首轮与继续追问共用（定时器、完成/失败收尾、running 释放） */
  private async executeTurn(
    session: Session,
    text: string,
    images?: ImageContent[]
  ): Promise<void> {
    const agent = session.agent
    if (!agent) {
      session.running = false
      if (this.runningId === session.state.id) this.runningId = null
      return
    }
    session.state.status = 'running'
    this.push(true)
    this.clearTaskTimer(session)
    session.taskTimer = setTimeout(() => {
      if (this.activeId !== session.state.id) this.activeId = session.state.id
      this.cancel('timeout')
    }, TASK_TIMEOUT_MS)
    try {
      await agent.prompt(text, images && images.length > 0 ? images : undefined)
      // 中止可能发生在 await 期间：状态被 cancel() 改成 cancelled 时不覆盖
      if ((session.state.status as AgentState['status']) === 'cancelled') return
      session.state.summary = this.translator.extractSummary(agent)
      session.state.status = 'done'
      session.state.endedAt = Date.now()
      this.audit('done', { id: session.state.id, steps: session.state.steps.length })
      this.releaseExtraAgents()
      this.push(true)
      this.pushTasks()
      this.scheduleSave()
    } catch (err) {
      if ((session.state.status as AgentState['status']) === 'cancelled') return
      session.state.status = 'failed'
      session.state.error = sanitizeError((err as Error)?.message ?? String(err))
      session.state.endedAt = Date.now()
      this.audit('failed', { id: session.state.id, error: session.state.error })
      this.push(true)
      this.pushTasks()
      this.scheduleSave()
    } finally {
      this.clearTaskTimer(session)
      this.finishRound(session)
      session.running = false
      if (this.runningId === session.state.id) this.runningId = null
    }
  }

  /** 本轮收尾：在步骤流末尾追加一条统计（耗时 / 调用 / token） */
  private finishRound(session: Session): void {
    if (session.roundCalls <= 0) return
    const endedAt = Date.now()
    const startedAt = session.roundStartedAt || endedAt
    session.roundStartedAt = 0
    this.translator.pushStep(session, {
      id: `stats-${session.turn}-${endedAt}`,
      kind: 'stats',
      title: '本轮统计',
      status: 'done',
      startedAt,
      endedAt,
      stats: {
        calls: session.roundCalls,
        input: session.roundInput,
        output: session.roundOutput,
        cacheRead: session.roundCache,
        contextUsed: session.state.context?.used,
        contextWindow: session.state.context?.window
      }
    })
    session.roundCalls = 0
    session.roundInput = 0
    session.roundOutput = 0
    session.roundCache = 0
  }

  // ---------------- 确认 ----------------

  private askApproval(
    session: Session,
    toolName: string,
    desc: ApprovalDescription
  ): Promise<boolean> {
    // 一批里可能有多个待确认调用：排队逐个弹，避免后一个覆盖前一个的 pending
    const task = session.approvalChain.then(() => this.waitForApproval(session, toolName, desc))
    session.approvalChain = task.catch(() => false)
    return task
  }

  private waitForApproval(
    session: Session,
    toolName: string,
    desc: ApprovalDescription
  ): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const id = randomUUID()
      const request: AgentApprovalRequest = {
        ...desc,
        id,
        tool: toolName,
        expiresAt: Date.now() + APPROVAL_TIMEOUT_MS
      }
      const timer = setTimeout(() => {
        if (session.pending?.id !== id) return
        session.pending = null
        session.state.approval = undefined
        if (session.state.status === 'waiting') session.state.status = 'running'
        this.audit('approval', {
          id: session.state.id,
          approvalId: id,
          allow: false,
          reason: 'timeout'
        })
        this.touch(session)
        resolve(false)
      }, APPROVAL_TIMEOUT_MS)

      session.pending = { id, timer, resolve }
      session.state.approval = request
      session.state.status = 'waiting'
      this.touch(session)
    })
  }

  private resolveApproval(session: Session, allow: boolean): void {
    const pending = session.pending
    if (!pending) return
    clearTimeout(pending.timer)
    session.pending = null
    pending.resolve(allow)
  }

  // ---------------- 生命周期杂项 ----------------

  private activeSession(): Session | null {
    if (!this.activeId) return null
    return this.sessions.get(this.activeId) ?? null
  }

  /** 任务状态变化：更新更新时间（落盘排序用）+ 只在当前任务上推送 */
  private touch(session: Session): void {
    session.updatedAt = Date.now()
    if (session.state.id === this.activeId) this.push(false)
    this.scheduleSave()
  }

  /** 释放超出上限的 Agent（只影响续聊，步骤/总结仍可回看） */
  private releaseExtraAgents(): void {
    const alive = [...this.sessions.values()]
      .filter((session) => session.agent !== null)
      .sort((a, b) => b.updatedAt - a.updatedAt)
    for (const session of alive.slice(MAX_LIVE_AGENTS)) {
      session.agent = null
    }
  }

  /** 懒加载：首次使用时读盘（避免 import 期访问 app.getPath） */
  private ensureLoaded(): void {
    if (this.loaded) return
    this.loaded = true
    const persisted = loadSessions()
    for (const record of persisted.sessions) {
      const interrupted =
        record.status === 'running' || record.status === 'preparing' || record.status === 'waiting'
      this.sessions.set(record.id, restoreSession(record))
    }
    this.activeId =
      persisted.activeId && this.sessions.has(persisted.activeId)
        ? persisted.activeId
        : (persisted.sessions[0]?.id ?? null)
  }

  private scheduleSave(): void {
    if (this.saveTimer) return
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      const data: PersistedState = {
        activeId: this.activeId,
        sessions: [...this.sessions.values()].map(
          (session): PersistedSession => ({
            id: session.state.id,
            task: session.state.task,
            workspace: session.state.workspace,
            createdAt: session.createdAt,
            updatedAt: session.updatedAt,
            status: session.state.status,
            steps: session.state.steps,
            todos: session.state.todos,
            usage: session.state.usage,
            summary: session.state.summary,
            error: session.state.error
          })
        )
      }
      saveSessions(data)
    }, SAVE_DEBOUNCE_MS)
  }

  // ---------------- 推送 / 审计 ----------------

  private push(immediate: boolean): void {
    if (immediate) {
      this.flush()
      return
    }
    if (this.pushTimer) return
    this.pushTimer = setTimeout(() => {
      this.pushTimer = null
      this.flush()
    }, PUSH_THROTTLE_MS)
  }

  private flush(): void {
    const session = this.activeSession()
    const state = session ? session.state : emptyState()
    const snapshot: AgentState = {
      ...state,
      resumable: session !== null && session.agent !== null,
      steps: state.steps.map((step) => ({ ...step })),
      todos: state.todos.map((item) => ({ ...item })),
      approval: state.approval ? { ...state.approval } : undefined
    }
    for (const listener of this.stateListeners) {
      try {
        listener(snapshot)
      } catch (err) {
        console.error('[agent] 状态推送失败：', (err as Error).message)
      }
    }
  }

  private pushTasks(): void {
    const tasks = this.listTasks()
    for (const listener of this.tasksListeners) {
      try {
        listener(tasks)
      } catch (err) {
        console.error('[agent] 任务列表推送失败：', (err as Error).message)
      }
    }
  }

  private audit(event: string, data: Record<string, unknown>): void {
    try {
      const dir = join(app.getPath('userData'), 'logs')
      mkdirSync(dir, { recursive: true })
      appendFileSync(
        join(dir, 'agent-audit.jsonl'),
        JSON.stringify({ at: new Date().toISOString(), event, ...data }) + '\n',
        'utf8'
      )
    } catch (err) {
      console.warn('[agent] 审计日志写入失败：', (err as Error).message)
    }
  }

  private clearTaskTimer(session: Session): void {
    if (!session.taskTimer) return
    clearTimeout(session.taskTimer)
    session.taskTimer = null
  }
}

/** 单例（与 backendManager 一致的生活周期） */
export const agentService = new AgentService()
