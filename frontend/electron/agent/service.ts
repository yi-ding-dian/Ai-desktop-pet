/**
 * 任务模式服务（2026-10-23）：多任务的完整生命周期。
 *
 * 职责：
 *  - 校验工作区 → 向后端内部端点取聊天 Key → 建 pi-agent-core Agent；
 *  - 每个任务一个 Session：步骤、待办、确认卡、Agent 上下文各自独立；
 *  - 把 Agent 事件流翻译成面板步骤，节流推给渲染层；
 *  - 按执行模式（标准/自动/计划）决定确认与拒绝（beforeToolCall → policy）；
 *  - 最多 2 个任务真并行，其余排队；同工作区互斥；
 *  - 支持 ask_user 提问卡、计划模式「按此执行」；
 *  - 中止、超时、审计、错误脱敏；任务记录落盘，重启后可回看。
 *
 * 目录分工：session（会话模型与常量）/ queue（并发队列纯逻辑）/ policy（权限）/
 * attachments / events（事件翻译）/ llm-key / store（落盘）。
 */
import { randomUUID } from 'node:crypto'
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { app, shell } from 'electron'
import type { Agent } from '@earendil-works/pi-agent-core'
import type { ImageContent } from '@earendil-works/pi-ai'
import {
  buildAgent,
  normalizeThinkingLevel,
  thinkingLevelsForModel,
  type BuiltAgent
} from './pi'
import { priceForModel } from './pricing'
import { createTools, describeToolCall, type ApprovalDescription } from './tools'
import { decideToolCall, MUTATION_TOOL_NAMES } from './policy'
import { MAX_PARALLEL_TASKS, findRunnableIndex, type QueueItem } from './queue'
import { resolveWorkspace } from './workspace'
import { lastAssistantFailure } from './model-failure'
import { loadSessions, saveSessions, type PersistedSession, type PersistedState } from './store'
import {
  deleteTranscript,
  hasTranscript,
  loadTranscript,
  pruneTranscripts,
  saveTranscript,
  transcriptDir
} from './transcript'
import { buildPrompt, normalizeAttachments } from './attachments'
import { AgentEventTranslator } from './events'
import { fetchLlmKey } from './llm-key'
import { callInternal, callInternalGet } from './internal-api'
import { deletePastedImages } from '../file-picker'
import { buildModeInstruction } from './prompt'
import {
  APPROVAL_TIMEOUT_MS,
  MAX_LIVE_AGENTS,
  PUSH_THROTTLE_MS,
  SAVE_DEBOUNCE_MS,
  TASK_TIMEOUT_MS,
  clipText,
  createSession,
  emptyState,
  finalizeRunningSteps,
  normalizeMode,
  restoreSession,
  sanitizeError,
  type Session,
  type StateListener,
  type TasksListener
} from './session'
import type {
  AgentApprovalRequest,
  AgentAttachment,
  AgentAttention,
  AgentExecutePlanPayload,
  AgentFollowUpPayload,
  AgentQuestionAnswerPayload,
  AgentSetModePayload,
  AgentStartPayload,
  AgentState,
  AgentTaskSummary,
  ExecutionMode
} from './types'

export class AgentService {
  private sessions = new Map<string, Session>()
  private activeId: string | null = null
  /** 正在执行的任务（最多 MAX_PARALLEL_TASKS 个） */
  private runningIds = new Set<string>()
  /** 工作区 realpath → 正在使用它的任务 id（同工作区互斥） */
  private workspaceRuns = new Map<string, string>()
  /** 等待执行的任务（start / continue 各一条） */
  private queue: QueueItem[] = []
  private stateListeners = new Set<StateListener>()
  private tasksListeners = new Set<TasksListener>()
  private attentionListeners = new Set<(event: AgentAttention) => void>()
  private pushTimer: NodeJS.Timeout | null = null
  private saveTimer: NodeJS.Timeout | null = null
  private loaded = false
  /** 正在读附件的追问（同一任务并发追问时防止慢的那条被后一条插队） */
  private readonly preparingFollowUps = new Set<string>()
  /** 当前模型（面板副标题用） */
  private modelId = ''
  /** 任务面板是否正在显示（且工作窗可见）——决定完成时是否标未读 */
  private panelActive = false
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

  /** 后台任务进入等待（确认/回答）时提醒主进程弹通知 */
  onAttention(listener: (event: AgentAttention) => void): () => void {
    this.attentionListeners.add(listener)
    return () => this.attentionListeners.delete(listener)
  }

  /** 当前任务状态（没有任务时返回空态） */
  getState(): AgentState {
    this.ensureLoaded()
    return this.snapshotOf(this.activeSession())
  }

  /** 左侧列表（按更新时间倒序） */
  listTasks(): AgentTaskSummary[] {
    this.ensureLoaded()
    return [...this.sessions.values()]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((session) => {
        const queueIndex = this.queue.findIndex((item) => item.sessionId === session.state.id)
        return {
          id: session.state.id,
          task: session.state.task,
          workspace: session.state.workspace,
          createdAt: session.createdAt,
          updatedAt: session.updatedAt,
          status: session.state.status,
          mode: session.state.mode,
          waitingFor:
            session.pending !== null
              ? ('approval' as const)
              : session.pendingQuestion !== null
                ? ('question' as const)
                : undefined,
          queuePosition: queueIndex >= 0 ? queueIndex + 1 : undefined,
          hasUpdate: session.hasUpdate
        }
      })
  }

  /** 切换当前任务 */
  select(id: string): { ok: boolean; error?: string } {
    this.ensureLoaded()
    if (!this.sessions.has(id)) return { ok: false, error: '任务不存在' }
    this.activeId = id
    const session = this.sessions.get(id)
    if (session?.hasUpdate) session.hasUpdate = false
    this.flush()
    this.pushTasks()
    this.scheduleSave()
    return { ok: true }
  }

  /**
   * 任务面板显隐（渲染侧上报）：只作为"完成时是否标未读"的判断依据。
   * 未读标记只在用户**点开具体任务**（select）时清除——回到任务页不自动清。
   */
  setPanelActive(active: boolean): void {
    this.panelActive = active
  }

  /** 删除一个任务（运行中的先中止）；删掉当前任务后自动切到最近的一条 */
  deleteTask(id: string): { ok: boolean; error?: string } {
    this.ensureLoaded()
    const session = this.sessions.get(id)
    if (!session) return { ok: false, error: '任务不存在' }

    this.dropQueue(id)
    this.clearTaskTimer(session)
    session.state.status = 'cancelled'
    finalizeRunningSteps(session.state.steps, Date.now())
    session.agent?.abort()
    this.resolveApproval(session, false)
    this.resolveQuestion(session, null)
    session.state.approval = undefined
    session.state.question = undefined
    session.agent = null
    this.sessions.delete(id)
    deleteTranscript(id, this.transcriptRoot())
    // 粘贴图片是主进程落盘的副本：任务删除后一并清理（仍被其他任务引用的保留）
    const stillReferenced = new Set<string>()
    for (const other of this.sessions.values()) {
      for (const path of other.attachmentPaths) stillReferenced.add(path)
    }
    deletePastedImages(session.attachmentPaths.filter((path) => !stillReferenced.has(path)))
    this.audit('delete', { id })
    if (this.activeId === id) {
      const next = [...this.sessions.values()].sort((a, b) => b.updatedAt - a.updatedAt)[0]
      this.activeId = next ? next.state.id : null
    }
    this.releaseExecution(session)
    this.pumpQueue()
    this.flush()
    this.pushTasks()
    this.scheduleSave()
    return { ok: true }
  }

  /** 开始新任务：校验通过即入队；有空槽位时立即启动 */
  start(payload: AgentStartPayload): { ok: boolean; error?: string } {
    this.ensureLoaded()
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
    const mode = normalizeMode(payload?.mode)
    const session: Session = createSession(id, task, workspace, now, mode)
    session.attachmentPaths.push(...attachments.map((item) => item.path))
    session.roundStartedAt = now
    session.roundCalls = 0
    session.roundInput = 0
    session.roundOutput = 0
    session.roundCache = 0
    this.sessions.set(id, session)
    this.activeId = id
    this.queue.push({ sessionId: id, workspace, kind: 'start', enqueuedAt: now, attachments })
    this.push(true)
    this.pushTasks()
    this.scheduleSave()
    this.pumpQueue()
    return { ok: true }
  }

  /**
   * 继续追问：作用于**当前任务**，沿用同一个 Agent（带上下文）。
   *
   * 运行中作为插话（steer）；排队中拒绝；有槽位立即执行，否则排队。
   */
  async followUp(
    payload: AgentFollowUpPayload | string
  ): Promise<{ ok: boolean; error?: string }> {
    this.ensureLoaded()
    const session = this.activeSession()
    if (!session) return { ok: false, error: '还没有任务，先开始一个' }
    if (!session.agent && !session.hasTranscript) {
      return { ok: false, error: '这个任务的上下文已释放（应用重启或超出保留数），点「新任务」重新开始' }
    }
    const text = typeof payload === 'string' ? payload : (payload?.text ?? '')
    const trimmed = text.trim()
    if (!trimmed) return { ok: false, error: '内容不能为空' }
    if (trimmed.length > 2000) return { ok: false, error: '内容过长（上限 2000 字）' }
    if (session.state.status === 'queued') {
      return { ok: false, error: '任务在排队，开始后再发送' }
    }
    if (session.state.status === 'waiting') {
      return { ok: false, error: '请先处理上方的确认/提问' }
    }
    const sessionId = session.state.id
    if (this.preparingFollowUps.has(sessionId)) {
      return { ok: false, error: '上一条还在读取附件，请稍后再发' }
    }

    const attachments = normalizeAttachments(
      typeof payload === 'string' ? [] : payload?.attachments
    )
    for (const item of attachments) {
      if (!session.attachmentPaths.includes(item.path)) session.attachmentPaths.push(item.path)
    }
    // 附件抽取是异步的（PDF/Office 走后端）：先占住本任务的准备位，保证后发不先到
    let prompt: { text: string; images: ImageContent[] }
    this.preparingFollowUps.add(sessionId)
    try {
      prompt = await buildPrompt(trimmed, attachments, callInternal)
      // 重启/超出保留数/被释放后没有 Agent：按 transcript 懒重建上下文再继续
      if (!session.agent) {
        const resumed = await this.attachAgent(session)
        if (!resumed.ok) return { ok: false, error: resumed.error }
      }
    } finally {
      this.preparingFollowUps.delete(sessionId)
    }

    // 文档抽取可能耗时；期间任务可能被删掉，不能再往旧 Agent 里塞插话
    if (!session.agent) {
      return { ok: false, error: '任务刚刚结束，请重新开始' }
    }

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

    return this.enqueueContinue(session, prompt.text, prompt.images)
  }

  /** 计划任务「按此执行」：切到标准/自动后在同一 Agent 上下文继续。 */
  async executePlan(payload: AgentExecutePlanPayload): Promise<{ ok: boolean; error?: string }> {
    this.ensureLoaded()
    const session = this.sessions.get(payload?.id ?? '')
    if (!session) return { ok: false, error: '任务不存在' }
    if (session.state.status !== 'planned') {
      return { ok: false, error: '这个任务当前不是「待执行」状态' }
    }
    if (!session.agent && !session.hasTranscript) {
      return { ok: false, error: '任务上下文已释放，无法按此执行；请新开任务' }
    }
    if (!session.agent) {
      const resumed = await this.attachAgent(session)
      if (!resumed.ok) return { ok: false, error: resumed.error }
    }
    const mode: ExecutionMode = payload.mode === 'auto' ? 'auto' : 'standard'
    const switched = this.setMode({ id: session.state.id, mode })
    if (!switched.ok) return switched
    // 用户已经点过「按此执行」，这一次动手不再重复弹首次确认
    session.firstWriteConfirmed = true
    return this.enqueueContinue(
      session,
      '用户已批准上面的计划。请按计划开始执行：先用 todo 更新进度，再逐步完成；完成后给出改了什么/怎么验证/剩余风险。'
    )
  }

  /** 中止指定任务：关掉 Agent、拒掉在途确认/提问、清理定时器 */
  cancel(id: string, reason: 'user' | 'timeout' = 'user'): { ok: boolean; error?: string } {
    this.ensureLoaded()
    const session = this.sessions.get(id)
    if (!session) return { ok: false, error: '任务不存在' }
    const status = session.state.status
    if (status === 'done' || status === 'failed' || status === 'cancelled') {
      return { ok: false, error: '任务已经结束' }
    }

    this.dropQueue(id)
    this.clearTaskTimer(session)
    session.agent?.abort()
    this.resolveApproval(session, false)
    this.resolveQuestion(session, null)
    session.state.approval = undefined
    session.state.question = undefined
    session.state.status = 'cancelled'
    session.state.endedAt = Date.now()
    finalizeRunningSteps(session.state.steps, session.state.endedAt)
    session.state.error = reason === 'timeout' ? '任务超过 30 分钟上限，已自动中止' : undefined
    this.markFinished(session)
    // 被 abort 的 Agent 不能续跑：清掉，继续聊需要重新开始任务
    session.agent = null
    this.releaseExecution(session)
    this.pumpQueue()
    this.audit('cancel', { id: session.state.id, reason })
    if (session.state.id === this.activeId) this.push(true)
    this.pushTasks()
    this.scheduleSave()
    return { ok: true }
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
      this.pushTasks()
      return
    }
  }

  /** 用户回答提问（按 pending id 找所属任务） */
  respondQuestion(payload: AgentQuestionAnswerPayload): { ok: boolean; error?: string } {
    const answer = (payload?.answer ?? '').trim()
    for (const session of this.sessions.values()) {
      const pending = session.pendingQuestion
      if (!pending || pending.id !== payload?.id) continue
      this.resolveQuestion(session, answer || null)
      session.state.question = undefined
      if (session.state.status === 'waiting') session.state.status = 'running'
      this.audit('question-answer', {
        id: session.state.id,
        questionId: pending.id,
        answered: answer.length > 0
      })
      if (session.state.id === this.activeId) this.push(true)
      this.pushTasks()
      return { ok: true }
    }
    return { ok: false, error: '问题已经结束' }
  }

  /** 任务内切换执行模式：从下一次工具调用起生效 */
  setMode(payload: AgentSetModePayload): { ok: boolean; error?: string } {
    this.ensureLoaded()
    const session = this.sessions.get(payload?.id ?? '')
    if (!session) return { ok: false, error: '任务不存在' }
    const mode = normalizeMode(payload.mode)
    if (session.state.mode === mode) return { ok: true }

    // 切到只读前先把在途确认按拒绝收尾，避免切完还执行旧确认
    if (mode === 'plan' && session.pending) {
      this.resolveApproval(session, false)
      session.state.approval = undefined
      if (session.state.status === 'waiting') session.state.status = 'running'
    }

    session.mode = mode
    session.state.mode = mode
    // 换了模式就重新给一次「首次动手」确认（从计划切到标准时尤其需要）
    session.firstWriteConfirmed = false
    this.audit('mode-change', { id: session.state.id, mode })
    if (session.agent) {
      const message = {
        role: 'system' as const,
        content: buildModeInstruction(mode),
        timestamp: Date.now()
      }
      try {
        if (session.running || session.state.status === 'waiting') {
          session.agent.steer(message)
        } else {
          session.agent.state.messages = [...session.agent.state.messages, message]
        }
      } catch (err) {
        // 提示词更新失败不影响权限切换（policy 每次读实时 mode）
        console.warn('[agent] 模式说明注入失败：', (err as Error).message)
      }
    }
    if (session.state.id === this.activeId) this.push(true)
    this.pushTasks()
    this.scheduleSave()
    return { ok: true }
  }

  // ---------------- 执行与并发 ----------------

  /** 把一轮「继续」放进队列；有空槽位会立即被 pumpQueue 拉起。 */
  private enqueueContinue(
    session: Session,
    text: string,
    images?: ImageContent[]
  ): { ok: boolean; error?: string } {
    if (this.queue.some((item) => item.sessionId === session.state.id)) {
      return { ok: false, error: '这个任务已经有一轮在排队' }
    }
    session.roundStartedAt = Date.now()
    session.roundCalls = 0
    session.roundInput = 0
    session.roundOutput = 0
    session.roundCache = 0
    session.roundCost = 0
    session.state.status = 'queued'
    session.state.error = undefined
    session.state.endedAt = undefined
    session.state.approval = undefined
    session.state.question = undefined
    this.queue.push({
      sessionId: session.state.id,
      workspace: session.state.workspace,
      kind: 'continue',
      enqueuedAt: Date.now(),
      text,
      images
    })
    if (session.state.id === this.activeId) this.push(true)
    this.pushTasks()
    this.scheduleSave()
    this.pumpQueue()
    return { ok: true }
  }

  /** 尝试按队列启动任务；槽位或工作区不满足时停止。 */
  private pumpQueue(): void {
    while (this.runningIds.size < MAX_PARALLEL_TASKS) {
      const index = findRunnableIndex(this.queue, new Set(this.workspaceRuns.keys()))
      if (index < 0) break
      const [item] = this.queue.splice(index, 1)
      const session = this.sessions.get(item.sessionId)
      if (!session) continue
      const status = session.state.status
      if (status === 'cancelled' || status === 'failed' || status === 'done') continue

      this.runningIds.add(session.state.id)
      this.workspaceRuns.set(session.state.workspace, session.state.id)
      session.running = true
      session.state.status = item.kind === 'start' ? 'preparing' : 'running'
      if (item.kind === 'continue') {
        session.roundGenMs = 0
        session.turnStartedAt = 0
      }
      if (session.state.id === this.activeId) this.push(true)
      this.pushTasks()
      if (item.kind === 'start') {
        void this.launch(session, item.attachments ?? [])
      } else {
        void this.executeTurn(session, item.text ?? '', item.images)
      }
    }
  }

  /** 释放执行槽位并尝试拉起队列里的下一个（幂等）。 */
  private releaseExecution(session: Session): void {
    const id = session.state.id
    const released = this.runningIds.delete(id)
    if (this.workspaceRuns.get(session.state.workspace) === id) {
      this.workspaceRuns.delete(session.state.workspace)
    }
    session.running = false
    if (released) this.pumpQueue()
  }

  /** 移除某个任务尚未开始的排队项。 */
  private dropQueue(id: string): void {
    this.queue = this.queue.filter((item) => item.sessionId !== id)
  }

  /**
   * 按当前配置建 Agent（新任务与重启后恢复共用）。
   *
   * 恢复时把 transcript 里的历史消息追加到新 system 提示之后；
   * 文件损坏直接报错，不静默按空上下文继续（否则模型会「失忆」还照常回答）。
   */
  private async createSessionAgent(session: Session): Promise<BuiltAgent> {
    const workspace = session.state.workspace
    // Key 与任务配置并行取；配置失败只影响思考强度（回退 high），不阻断任务
    const [key, agentConfig] = await Promise.all([
      fetchLlmKey(),
      callInternalGet('/internal/agent-config').catch((err) => {
        console.warn('[agent] 读取任务配置失败，思考强度按 high：', (err as Error).message)
        return null
      })
    ])
    const tools = createTools({
      workspace,
      // 数组原地追加：后续追问附上的文件也能被 read_file 读到
      extraReadPaths: session.attachmentPaths,
      onTodo: (items) => this.translator.applyTodo(session, items),
      // 联网搜索/抓取：开关与格式化都在后端（设置 → 搜索）
      callInternal,
      askUser: (question, options) => this.askQuestion(session, question, options),
      trashPath: (abs) => shell.trashItem(abs)
    })
    const history = session.hasTranscript
      ? loadTranscript(session.state.id, this.transcriptRoot())
      : []
    if (history === null) {
      throw new Error('任务对话记录损坏，无法恢复上下文；请新开一个任务')
    }
    // 配置里的强度若不被当前模型支持（如 v4-pro 的 low），回退 high
    const configuredThinking = normalizeThinkingLevel(agentConfig?.thinkingLevel)
    const thinkingLevel = thinkingLevelsForModel(key.model).includes(configuredThinking)
      ? configuredThinking
      : 'high'

    return buildAgent({
      apiKey: key.key,
      baseUrl: key.baseUrl,
      model: key.model,
      mode: session.state.mode,
      thinkingLevel,
      tools,
      history,
      beforeToolCall: async ({ toolCall, args }) => {
        let decision = decideToolCall({
          mode: session.state.mode,
          toolName: toolCall.name,
          args,
          workspace
        })
        // 标准模式：本任务第一次写/改/删强制确认一次（2026-10-26）。
        // 用户只是在讨论时，模型不该默默改文件；确认后本任务内不再打扰。
        if (
          decision.action === 'allow' &&
          session.state.mode === 'standard' &&
          !session.firstWriteConfirmed &&
          MUTATION_TOOL_NAMES.has(toolCall.name)
        ) {
          decision = {
            action: 'confirm',
            dangerous: false,
            reason: '这是本任务第一次动手修改文件；确认后本任务内写/改/删不再询问。'
          }
        }
        if (decision.action === 'allow') return undefined
        if (decision.action === 'deny') {
          this.audit('tool-denied', {
            id: session.state.id,
            tool: toolCall.name,
            mode: session.state.mode,
            reason: decision.reason
          })
          return { block: true, reason: decision.reason }
        }
        const desc = describeToolCall(toolCall.name, args, workspace)
        const allowed = await this.askApproval(session, toolCall.name, {
          ...desc,
          dangerous: decision.dangerous || desc.dangerous,
          preview: [decision.reason, desc.preview].filter(Boolean).join('\n\n') || undefined
        })
        if (allowed) {
          if (
            session.state.mode === 'standard' &&
            MUTATION_TOOL_NAMES.has(toolCall.name)
          ) {
            session.firstWriteConfirmed = true
          }
          this.audit('tool-auto', {
            id: session.state.id,
            tool: toolCall.name,
            mode: session.state.mode,
            decision: 'confirmed'
          })
          return undefined
        }
        return {
          block: true,
          reason: '用户拒绝了这次操作。不要原样重试，换方案或停下来问用户。'
        }
      }
    })
  }

  /** 把建好的 Agent 挂到会话上（模型信息 / 事件订阅）。 */
  private installAgent(session: Session, built: BuiltAgent): void {
    session.agent = built.agent
    this.modelId = built.modelId
    session.state.model = built.modelId
    // 费用估算按模型单价；自定义/未知模型为 null，面板不显示费用
    session.price = priceForModel(built.modelId)
    session.state.context = { used: 0, window: built.contextWindow }
    session.agent.subscribe((event) => this.translator.onAgentEvent(session, event))
  }

  /** 懒恢复：重启 / Agent 被释放后，第一次追问时按 transcript 重建上下文。 */
  private async attachAgent(session: Session): Promise<{ ok: boolean; error?: string }> {
    if (session.agent) return { ok: true }
    if (!session.hasTranscript) return { ok: false, error: '任务上下文已释放，请新开任务' }
    // 标记后文件被人为删掉：宁可报错，也不要按空上下文继续（模型会「失忆」）
    if (!hasTranscript(session.state.id, this.transcriptRoot())) {
      session.hasTranscript = false
      return { ok: false, error: '任务对话记录已丢失，无法恢复；请新开任务' }
    }
    try {
      const built = await this.createSessionAgent(session)
      // 建 Agent 期间任务可能已被删除
      if (this.sessions.get(session.state.id) !== session) {
        return { ok: false, error: '任务已被删除' }
      }
      this.installAgent(session, built)
      this.audit('resume', {
        id: session.state.id,
        messages: built.agent.state.messages.length,
        attachments: session.attachmentPaths.length
      })
      this.scheduleSave()
      return { ok: true }
    } catch (err) {
      return { ok: false, error: sanitizeError((err as Error)?.message ?? String(err)) }
    }
  }

  private async launch(session: Session, attachments: AgentAttachment[]): Promise<void> {
    const workspace = session.state.workspace
    try {
      const built = await this.createSessionAgent(session)

      // 准备期间任务可能已被取消/删除
      if (session.state.status === 'cancelled' || !this.sessions.has(session.state.id)) {
        this.releaseExecution(session)
        return
      }
      this.installAgent(session, built)
      this.audit('start', {
        id: session.state.id,
        task: session.state.task,
        workspace,
        mode: session.state.mode,
        model: this.modelId,
        attachments: session.attachmentPaths.length
      })
      const prompt = await buildPrompt(session.state.task, attachments, callInternal)
      await this.executeTurn(session, prompt.text, prompt.images)
    } catch (err) {
      // 走到这里只可能是准备阶段失败（取 Key / 建 Agent）
      if (session.state.status === 'cancelled') {
        this.releaseExecution(session)
        return
      }
      session.state.status = 'failed'
      session.state.error = sanitizeError((err as Error)?.message ?? String(err))
      session.state.endedAt = Date.now()
      finalizeRunningSteps(session.state.steps, session.state.endedAt)
      this.markFinished(session)
      session.agent = null
      this.audit('failed', { id: session.state.id, error: session.state.error })
      this.releaseExecution(session)
      this.push(true)
      this.pushTasks()
      this.scheduleSave()
      this.clearTaskTimer(session)
    }
  }

  /** 跑一轮对话：首轮与继续追问共用（定时器、完成/失败收尾、槽位释放） */
  private async executeTurn(
    session: Session,
    text: string,
    images?: ImageContent[]
  ): Promise<void> {
    const agent = session.agent
    if (!agent) {
      this.releaseExecution(session)
      return
    }
    session.state.status = 'running'
    // 每轮重新累计生成时长（首轮与继续追问共用）
    session.roundGenMs = 0
    session.roundPlanned = false
    session.turnStartedAt = 0
    this.push(true)
    this.clearTaskTimer(session)
    session.taskTimer = setTimeout(() => {
      this.cancel(session.state.id, 'timeout')
    }, TASK_TIMEOUT_MS)
    try {
      await agent.prompt(text, images && images.length > 0 ? images : undefined)
      // 中止可能发生在 await 期间：状态被 cancel() 改成 cancelled 时不覆盖
      if ((session.state.status as AgentState['status']) === 'cancelled') return
      // pi-agent 把 API/鉴权错误放在最后一条 assistant 消息的 stopReason=error 上正常返回，
      // 不抛异常；不检查会把失败误标成「已完成」，界面也不会提示（2026-10-26 DeepSeek 401）。
      const failure = readTurnFailure(agent)
      if (failure) {
        this.failTurn(session, failure)
        return
      }
      session.state.summary = this.translator.extractSummary(agent)
      // 计划模式只有本轮真的用 todo 列了步骤才停在「待执行」；
      // 纯聊天/答疑正常结束为 done，避免每句话都弹「计划已完成」卡。
      session.state.status =
        session.state.mode === 'plan' && session.roundPlanned ? 'planned' : 'done'
      session.state.endedAt = Date.now()
      this.markFinished(session)
      this.audit(session.state.status === 'planned' ? 'planned' : 'done', {
        id: session.state.id,
        steps: session.state.steps.length
      })
      this.push(true)
      this.pushTasks()
      this.scheduleSave()
    } catch (err) {
      if ((session.state.status as AgentState['status']) === 'cancelled') return
      this.failTurn(session, (err as Error)?.message ?? String(err))
    } finally {
      this.clearTaskTimer(session)
      // 本轮结束（含中止/失败）把模型上下文落盘：重启后据此续聊
      this.persistTranscript(session, agent)
      this.finishRound(session)
      this.releaseExtraAgents()
      this.releaseExecution(session)
    }
  }

  /** 一轮失败收尾：异常与 stopReason=error 共用，保证状态/错误文案/推送一致。 */
  private failTurn(session: Session, message: string): void {
    session.state.status = 'failed'
    session.state.error = sanitizeError(message)
    session.state.endedAt = Date.now()
    finalizeRunningSteps(session.state.steps, session.state.endedAt)
    this.markFinished(session)
    this.audit('failed', { id: session.state.id, error: session.state.error })
    this.push(true)
    this.pushTasks()
    this.scheduleSave()
  }

  /** 把模型上下文落盘（裁剪规则在 transcript.ts）。 */
  private persistTranscript(session: Session, agent: Agent): void {
    // 任务已删除（abort 引发的 finally 晚于删除）：别把刚删的记录又写回来
    if (!this.sessions.has(session.state.id)) return
    try {
      const outcome = saveTranscript(
        session.state.id,
        agent.state.messages,
        this.transcriptRecap(session),
        this.transcriptRoot()
      )
      if (outcome.saved) session.hasTranscript = true
      if (outcome.dropped > 0) {
        this.audit('transcript-trim', { id: session.state.id, dropped: outcome.dropped })
      }
    } catch (err) {
      // 落盘失败只影响续聊，不影响本次任务结果
      console.warn('[agent] 对话记录保存失败：', (err as Error).message)
    }
  }

  /** 历史被裁剪时给模型的概要：只用已有的任务/步骤/总结，不编造细节。 */
  private transcriptRecap(session: Session): string {
    const rounds = session.state.steps
      .filter((step) => step.kind === 'round')
      .slice(-8)
      .map((step) => `- ${clipText(step.title, 160)}`)
    const lines = [
      '【较早的对话已被省略，下面是任务概要与用户后续要求；细节需要时请重新查看文件】',
      `任务：${clipText(session.state.task, 500)}`
    ]
    if (session.state.summary) lines.push(`最近总结：${clipText(session.state.summary, 1500)}`)
    if (rounds.length > 0) lines.push('用户后续要求：', ...rounds)
    return lines.join('\n')
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
        cost: session.price ? session.roundCost : undefined,
        generationMs: session.roundGenMs,
        contextUsed: session.state.context?.used,
        contextWindow: session.state.context?.window
      }
    })
    session.roundCost = 0
    session.roundCalls = 0
    session.roundInput = 0
    session.roundOutput = 0
    session.roundCache = 0
    session.roundGenMs = 0
    session.turnStartedAt = 0
  }

  // ---------------- 确认与提问 ----------------

  private askApproval(
    session: Session,
    toolName: string,
    desc: ApprovalDescription
  ): Promise<boolean> {
    // 一批里可能有多个待确认调用：排队逐个弹，避免后一个覆盖前一个的 pending
    const task = session.interactionChain.then(() =>
      this.waitForApproval(session, toolName, desc)
    )
    session.interactionChain = task.catch(() => false)
    return task
  }

  private waitForApproval(
    session: Session,
    toolName: string,
    desc: ApprovalDescription
  ): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      // 排队等待确认期间任务已被取消：不再弹卡
      if (session.state.status === 'cancelled') {
        resolve(false)
        return
      }
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
      this.notifyAttention(session, 'approval')
    })
  }

  private resolveApproval(session: Session, allow: boolean): void {
    const pending = session.pending
    if (!pending) return
    clearTimeout(pending.timer)
    session.pending = null
    pending.resolve(allow)
  }

  /** ask_user：与确认卡共用 interactionChain，保证同一任务不会同时出现两张卡。 */
  private askQuestion(
    session: Session,
    question: string,
    options: string[]
  ): Promise<string | null> {
    const task = session.interactionChain.then(() =>
      this.waitForAnswer(session, question, options)
    )
    session.interactionChain = task.catch(() => null)
    return task
  }

  private waitForAnswer(
    session: Session,
    question: string,
    options: string[]
  ): Promise<string | null> {
    return new Promise<string | null>((resolve) => {
      // 排队等待回答期间任务已被取消：直接按未回答结束
      if (session.state.status === 'cancelled') {
        resolve(null)
        return
      }
      const id = randomUUID()
      session.pendingQuestion = { id, resolve }
      session.state.question = {
        id,
        question,
        options,
        createdAt: Date.now()
      }
      session.state.status = 'waiting'
      this.touch(session)
      this.notifyAttention(session, 'question')
    })
  }

  private resolveQuestion(session: Session, answer: string | null): void {
    const pending = session.pendingQuestion
    if (!pending) return
    session.pendingQuestion = null
    pending.resolve(answer)
  }

  /** 后台任务进入等待时提醒主进程（当前正在看的任务不打扰）。 */
  private notifyAttention(session: Session, kind: 'approval' | 'question'): void {
    if (this.panelActive && this.activeId === session.state.id) return
    const event: AgentAttention = {
      id: session.state.id,
      task: session.state.task,
      kind
    }
    for (const listener of this.attentionListeners) listener(event)
  }

  // ---------------- 生命周期杂项 ----------------

  private activeSession(): Session | null {
    if (!this.activeId) return null
    return this.sessions.get(this.activeId) ?? null
  }

  /** transcript 根目录（userData/agent-transcripts） */
  private transcriptRoot(): string {
    return transcriptDir(app.getPath('userData'))
  }

  /** 进入结束态：用户没在看这个任务时标未读完成（点开/回到面板即清除） */
  private markFinished(session: Session): void {
    if (this.panelActive && this.activeId === session.state.id) return
    session.hasUpdate = true
  }

  /** 任务状态变化：更新更新时间（落盘排序用）+ 只在当前任务上推送 */
  private touch(session: Session): void {
    session.updatedAt = Date.now()
    if (session.state.id === this.activeId) this.push(false)
    this.scheduleSave()
  }

  /** 释放超出上限的 Agent（只影响续聊；运行中/排队中/当前任务不释放） */
  private releaseExtraAgents(): void {
    const pinned = new Set<string>(this.runningIds)
    for (const item of this.queue) pinned.add(item.sessionId)
    if (this.activeId) pinned.add(this.activeId)
    const alive = [...this.sessions.values()]
      .filter((session) => session.agent !== null && !pinned.has(session.state.id))
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
      const session = restoreSession(record)
      // transcript 在不在决定这个任务重启后能不能继续聊
      session.hasTranscript = hasTranscript(record.id, this.transcriptRoot())
      this.sessions.set(record.id, session)
    }
    // 被 MAX_SESSIONS 裁掉/删除失败留下的 transcript 一并清理。
    // 索引缺失/损坏时不清理：这时空列表不代表任务真的没了。
    if (persisted.healthy) {
      pruneTranscripts([...this.sessions.keys()], this.transcriptRoot())
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
            model: session.state.model,
            createdAt: session.createdAt,
            updatedAt: session.updatedAt,
            status: session.state.status,
            mode: session.state.mode,
            steps: session.state.steps,
            todos: session.state.todos,
            usage: session.state.usage,
            sources: session.state.sources,
            attachmentPaths: session.attachmentPaths,
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

  /** 对外快照：补上运行期才有的 resumable，并复制可变数组（避免渲染侧改到内部状态） */
  private snapshotOf(session: Session | null): AgentState {
    const state = session ? session.state : emptyState()
    return {
      ...state,
      // 有 Agent 可直接续；只有 transcript 也能在下次追问时懒重建
      resumable: session !== null && (session.agent !== null || session.hasTranscript),
      steps: state.steps.map((step) => ({ ...step })),
      todos: state.todos.map((item) => ({ ...item })),
      approval: state.approval ? { ...state.approval } : undefined,
      question: state.question
        ? { ...state.question, options: [...state.question.options] }
        : undefined
    }
  }

  private flush(): void {
    const snapshot = this.snapshotOf(this.activeSession())
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

/**
 * 读取本轮模型请求的失败原因（pi-agent 以 stopReason=error 正常返回，不抛异常）。
 * 只看最后一条 assistant，避免把历史轮次的错误当成当前失败。
 */
function readTurnFailure(agent: Agent): string | null {
  return lastAssistantFailure(agent.state?.messages ?? [])
}

/** 单例（与 backendManager 一致的生活周期） */
export const agentService = new AgentService()
