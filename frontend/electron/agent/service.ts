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
 */
import { randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { extname } from 'node:path'
import { join } from 'node:path'
import { app } from 'electron'
import type { Agent, AgentEvent } from '@earendil-works/pi-agent-core'
import type { ImageContent } from '@earendil-works/pi-ai'
import { backendManager } from '../backend-process'
import { buildAgent } from './pi'
import { createTools, describeToolCall, needsApproval, type ApprovalDescription } from './tools'
import { resolveWorkspace } from './workspace'
import { loadSessions, saveSessions, type PersistedSession, type PersistedState } from './store'
import type {
  AgentApprovalRequest,
  AgentAttachment,
  AgentFollowUpPayload,
  AgentStartPayload,
  AgentState,
  AgentStep,
  AgentTaskSummary,
  AgentTodoItem,
  AgentUsage
} from './types'

/** 确认卡等待上限（ms）：到点按拒绝处理 */
const APPROVAL_TIMEOUT_MS = 120_000
/** 单任务单轮总时长上限（ms） */
const TASK_TIMEOUT_MS = 30 * 60 * 1000
/** 步骤数量上限（超出丢最旧的已结束步骤） */
const MAX_STEPS = 200
/** 单条步骤正文上限（字符） */
const MAX_STEP_DETAIL = 12_000
/** 状态推送节流（ms） */
const PUSH_THROTTLE_MS = 120
/** 落盘防抖（ms） */
const SAVE_DEBOUNCE_MS = 1500
/** 单轮最多附件数（与对话模式一致） */
const MAX_ATTACHMENTS = 3
/** 图片附件上限（字节）与文本附件内联上限（字符） */
const MAX_IMAGE_BYTES = 8 * 1024 * 1024
const MAX_INLINE_TEXT = 20_000
const IMAGE_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif'
}

/** 最多保留多少个「可续聊」的 Agent（超出按最久未用释放，只影响续聊，不影响回看） */
const MAX_LIVE_AGENTS = 5

interface LlmKeyPayload {
  key: string
  baseUrl: string
  model: string
}

type StateListener = (state: AgentState) => void
type TasksListener = (tasks: AgentTaskSummary[]) => void

interface PendingApproval {
  id: string
  timer: NodeJS.Timeout
  resolve: (allow: boolean) => void
}

/** 一个任务的运行期状态（Agent 重启后为 null，仅可回看） */
interface Session {
  state: AgentState
  agent: Agent | null
  createdAt: number
  updatedAt: number
  /** 用户追问轮次（round step 用） */
  round: number
  /** 模型调用轮次（turn_start 递增） */
  turn: number
  /** 只有工具调用、没有正文的轮次：usage 暂存到工具行 */
  turnTokens: Map<number, { input: number; output: number }>
  /** 用户附上的文件原路径（read_file 只读放行） */
  attachmentPaths: string[]
  /** 本轮统计起点（一次用户消息 → 模型跑完为止） */
  roundStartedAt: number
  roundCalls: number
  roundInput: number
  roundOutput: number
  roundCache: number
  pending: PendingApproval | null
  approvalChain: Promise<unknown>
  taskTimer: NodeJS.Timeout | null
  running: boolean
}

function zeroUsage(): AgentUsage {
  return { calls: 0, input: 0, output: 0, cacheRead: 0 }
}

function emptyState(): AgentState {
  return {
    id: '',
    status: 'idle',
    task: '',
    workspace: '',
    steps: [],
    todos: [],
    usage: zeroUsage(),
    resumable: false
  }
}

/** 错误文案脱敏：去掉可能的 Key 片段 */
function sanitizeError(text: string): string {
  return text
    .replace(/sk-[A-Za-z0-9_-]{6,}/g, 'sk-***')
    .replace(/Bearer\s+[A-Za-z0-9._-]{6,}/gi, 'Bearer ***')
    .slice(0, 1000)
}

function clipText(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`
}

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

    const attachments = this.normalizeAttachments(payload?.attachments)
    const id = randomUUID()
    const now = Date.now()
    const session: Session = {
      state: {
        id,
        status: 'preparing',
        task,
        workspace,
        startedAt: now,
        steps: [],
        todos: [],
        usage: zeroUsage(),
        resumable: false
      },
      agent: null,
      createdAt: now,
      updatedAt: now,
      round: 0,
      turn: 0,
      turnTokens: new Map(),
      attachmentPaths: [],
      roundStartedAt: 0,
      roundCalls: 0,
      roundInput: 0,
      roundOutput: 0,
      roundCache: 0,
      pending: null,
      approvalChain: Promise.resolve(),
      taskTimer: null,
      running: true
    }
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

    const attachments = this.normalizeAttachments(
      typeof payload === 'string' ? [] : payload?.attachments
    )
    for (const item of attachments) {
      if (!session.attachmentPaths.includes(item.path)) session.attachmentPaths.push(item.path)
    }
    const prompt = this.buildPrompt(trimmed, attachments)

    session.round += 1
    this.pushStep(session, {
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

  /** 过滤附件：存在、是文件、最多 3 个 */
  private normalizeAttachments(list: AgentAttachment[] | undefined): AgentAttachment[] {
    if (!Array.isArray(list)) return []
    const result: AgentAttachment[] = []
    for (const item of list.slice(0, MAX_ATTACHMENTS)) {
      if (!item || typeof item.path !== 'string') continue
      try {
        if (!existsSync(item.path) || !statSync(item.path).isFile()) continue
      } catch {
        continue
      }
      result.push({
        path: item.path,
        name: item.name || item.path.split(/[\\/]/).pop() || item.path,
        kind: item.kind === 'image' ? 'image' : item.kind === 'text' ? 'text' : 'other'
      })
    }
    return result
  }

  /**
   * 把附件拼进这一轮消息：
   *  - 图片 → 作为 image content 直接给模型看（不复制文件）
   *  - 文本/代码 → 读取内容内联（单文件 2 万字上限）
   *  - 其它 → 只给路径（模型读不了）
   */
  private buildPrompt(
    text: string,
    attachments: AgentAttachment[]
  ): { text: string; images: ImageContent[] } {
    const parts: string[] = [text]
    const images: ImageContent[] = []
    for (const item of attachments) {
      const ext = extname(item.path).slice(1).toLowerCase()
      try {
        const stat = statSync(item.path)
        if (IMAGE_MIME[ext]) {
          if (stat.size > MAX_IMAGE_BYTES) {
            parts.push(`（图片 ${item.name} 超过 8MB，未随消息发送）`)
            continue
          }
          images.push({
            type: 'image',
            data: readFileSync(item.path).toString('base64'),
            mimeType: IMAGE_MIME[ext]
          })
          parts.push(`（用户附带图片：${item.name}，已随本条消息提供）`)
          continue
        }
        if (stat.size > MAX_INLINE_TEXT * 4) {
          parts.push(`（附件 ${item.path} 太大，未内联；需要时用 read_file 分段读取）`)
          continue
        }
        const buf = readFileSync(item.path)
        if (buf.subarray(0, 8192).includes(0)) {
          parts.push(`（附件 ${item.path} 是二进制文件，读不了内容）`)
          continue
        }
        const content = buf.toString('utf8')
        parts.push(
          `<附件 名称="${item.name}" 路径="${item.path}">\n${clipText(content, MAX_INLINE_TEXT)}\n</附件>`
        )
      } catch (err) {
        parts.push(`（附件 ${item.path} 读取失败：${(err as Error).message}）`)
      }
    }
    return { text: parts.join('\n\n'), images }
  }

  // ---------------- 执行 ----------------

  private async runTask(
    session: Session,
    task: string,
    workspace: string,
    attachments: AgentAttachment[]
  ): Promise<void> {
    try {
      const key = await this.fetchLlmKey()
      const tools = createTools({
        workspace,
        // 数组原地追加：后续追问附上的文件也能被 read_file 读到
        extraReadPaths: session.attachmentPaths,
        onTodo: (items) => this.applyTodo(session, items)
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
      session.agent.subscribe((event) => this.onAgentEvent(session, event))
      this.audit('start', {
        id: session.state.id,
        task,
        workspace,
        model: this.modelId,
        attachments: attachments.length
      })
      const prompt = this.buildPrompt(task, attachments)
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
      session.state.summary = this.extractSummary(agent)
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
    this.pushStep(session, {
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

  /** 向后端内部端点要聊天 Key（渲染层拿不到这条通道） */
  private async fetchLlmKey(): Promise<LlmKeyPayload> {
    const token = backendManager.getInternalToken()
    const snapshot = backendManager.getSnapshot()
    if (!token || !snapshot.port) throw new Error('后端还没就绪，请稍后再试')

    const res = await fetch(`http://127.0.0.1:${snapshot.port}/internal/llm-key`, {
      headers: { 'X-Pet-Internal-Token': token }
    })
    if (!res.ok) throw new Error(`读取聊天配置失败（HTTP ${res.status}）`)
    const data = (await res.json()) as {
      configured: boolean
      key: string
      baseUrl: string
      model: string
    }
    if (!data.configured || !data.key) {
      throw new Error('还没有配置聊天模型，请先到「设置 → LLM」里配置 Key')
    }
    return { key: data.key, baseUrl: data.baseUrl, model: data.model }
  }

  // ---------------- 事件 → 步骤 ----------------

  private onAgentEvent(session: Session, event: AgentEvent): void {
    if (session.state.status === 'cancelled') return
    switch (event.type) {
      case 'turn_start': {
        // 每次请求模型立刻给一个可见占位：等待首字时不至于像卡死
        session.turn += 1
        session.state.usage.calls += 1
        session.roundCalls += 1
        if (!session.roundStartedAt) session.roundStartedAt = Date.now()
        this.pushStep(session, {
          id: `thinking-${session.turn}`,
          kind: 'thinking',
          turn: session.turn,
          title: '思考过程',
          detail: '',
          status: 'running',
          startedAt: Date.now()
        })
        break
      }
      case 'message_update': {
        const inner = event.assistantMessageEvent
        if (inner.type === 'text_delta') {
          this.closeThinking(session, session.turn)
          this.appendStream(session, 'text', inner.delta, session.turn)
        } else if (inner.type === 'thinking_delta') {
          this.appendStream(session, 'thinking', inner.delta, session.turn)
        } else if (inner.type === 'text_end') {
          this.closeStream(session, 'text', session.turn)
        } else if (inner.type === 'thinking_end') {
          this.closeThinking(session, session.turn)
        }
        break
      }
      case 'message_end': {
        // 模型响应结束：累计 usage，并挂到本轮正文（没有正文就挂到本轮工具行）
        const message = event.message as {
          role?: string
          usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number }
        }
        if (message?.role !== 'assistant' || !message.usage) break
        const input = message.usage.input ?? 0
        const output = message.usage.output ?? 0
        const cacheRead = message.usage.cacheRead ?? 0
        session.state.usage.input += input
        session.state.usage.output += output
        session.state.usage.cacheRead += cacheRead
        session.roundInput += input
        session.roundOutput += output
        session.roundCache += cacheRead
        // 当前上下文 = 本次请求的输入（含缓存部分）+ 本次输出
        const windowSize = session.state.context?.window ?? 0
        const cacheWrite = message.usage.cacheWrite ?? 0
        session.state.context = {
          used: input + cacheRead + cacheWrite + output,
          window: windowSize
        }
        const turn = session.turn
        const textStep = session.state.steps.find((step) => step.id === `text-${turn}`)
        if (textStep) {
          textStep.tokens = { input, output }
        } else {
          // 这一轮只有工具调用、没有正文：留给该轮的工具行
          session.turnTokens.set(turn, { input, output })
          const toolStep = session.state.steps.find(
            (step) => step.kind === 'tool' && step.turn === turn
          )
          if (toolStep) {
            toolStep.tokens = { input, output }
            session.turnTokens.delete(turn)
          }
        }
        this.touch(session)
        break
      }
      case 'turn_end': {
        this.closeStream(session, 'text', session.turn)
        this.closeThinking(session, session.turn)
        break
      }
      case 'tool_execution_start': {
        const desc = describeToolCall(event.toolName, event.args, session.state.workspace)
        this.audit('tool', {
          id: session.state.id,
          name: event.toolName,
          args: JSON.stringify(event.args ?? {}).slice(0, 300)
        })
        const step: AgentStep = {
          id: event.toolCallId,
          kind: 'tool',
          turn: session.turn,
          title: desc.title,
          detail: desc.command ?? desc.preview,
          command: desc.command,
          status: 'running',
          startedAt: Date.now()
        }
        const tokens = session.turnTokens.get(session.turn)
        const hasToolToken = session.state.steps.some(
          (item) => item.kind === 'tool' && item.turn === session.turn && item.tokens
        )
        if (tokens && !hasToolToken) {
          step.tokens = tokens
          session.turnTokens.delete(session.turn)
        }
        this.pushStep(session, step)
        break
      }
      case 'tool_execution_update': {
        // 长命令的进度（如「已运行 42 秒…」）实时落到步骤详情，避免看起来卡死
        const step = session.state.steps.find((item) => item.id === event.toolCallId)
        if (!step) break
        const content = (event.partialResult as { content?: unknown } | undefined)?.content
        const text = Array.isArray(content)
          ? content
              .filter((block): block is { type: string; text: string } =>
                Boolean(block) && (block as { type?: string }).type === 'text'
              )
              .map((block) => block.text)
              .join(' ')
          : ''
        if (text) {
          step.detail = clipText(text, 200)
          this.touch(session)
        }
        break
      }
      case 'tool_execution_end': {
        const step = session.state.steps.find((item) => item.id === event.toolCallId)
        if (step) {
          step.status = event.isError ? 'failed' : 'done'
          step.endedAt = Date.now()
          const text = this.extractToolText(event)
          if (text) step.detail = clipText(text, 400)
          this.touch(session)
        }
        break
      }
      case 'agent_end': {
        this.closeStream(session, 'text', session.turn)
        this.closeThinking(session, session.turn)
        break
      }
      default:
        break
    }
  }

  private extractToolText(event: Extract<AgentEvent, { type: 'tool_execution_end' }>): string {
    const content = event.result?.content
    if (!Array.isArray(content)) return ''
    return content
      .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
      .map((block) => block.text)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim()
  }

  private appendStream(
    session: Session,
    kind: 'text' | 'thinking',
    delta: string,
    turn: number
  ): void {
    const id = `${kind}-${turn}`
    let step = session.state.steps.find((item) => item.id === id)
    if (!step) {
      step = {
        id,
        kind,
        turn,
        title: kind === 'text' ? '回复' : '思考过程',
        detail: '',
        status: 'running',
        startedAt: Date.now()
      }
      session.state.steps.push(step)
      this.trimSteps(session)
    }
    step.detail = clipText((step.detail ?? '') + delta, MAX_STEP_DETAIL)
    this.touch(session)
  }

  private closeStream(session: Session, kind: 'text' | 'thinking', turn: number): void {
    const step = session.state.steps.find((item) => item.id === `${kind}-${turn}`)
    if (!step || step.status !== 'running') return
    step.status = 'done'
    step.endedAt = Date.now()
    if (kind === 'text' && (step.detail ?? '').trim() === '') {
      session.state.steps = session.state.steps.filter((item) => item !== step)
    }
    this.touch(session)
  }

  /** 思考占位：收到正文或本轮结束就收口；没有思考内容则移除（运行中保留，用来显示「正在思考…」） */
  private closeThinking(session: Session, turn: number): void {
    const step = session.state.steps.find((item) => item.id === `thinking-${turn}`)
    if (!step || step.status !== 'running') return
    step.status = 'done'
    step.endedAt = Date.now()
    if ((step.detail ?? '').trim() === '') {
      session.state.steps = session.state.steps.filter((item) => item !== step)
    }
    this.touch(session)
  }

  private pushStep(session: Session, step: AgentStep): void {
    session.state.steps.push(step)
    this.trimSteps(session)
    this.touch(session)
  }

  /** 步骤上限：只丢已结束的最旧步骤，正在跑的保留 */
  private trimSteps(session: Session): void {
    if (session.state.steps.length <= MAX_STEPS) return
    const overflow = session.state.steps.length - MAX_STEPS
    let removed = 0
    session.state.steps = session.state.steps.filter((step) => {
      if (removed >= overflow) return true
      if (step.status === 'running') return true
      removed += 1
      return false
    })
  }

  private applyTodo(
    session: Session,
    items: Array<{ text: string; status: 'pending' | 'active' | 'done' }>
  ): void {
    const todos: AgentTodoItem[] = items.map((item, index) => ({
      id: `todo-${index}`,
      text: item.text,
      status: item.status
    }))
    session.state.todos = todos
    const step = session.state.steps.find((item) => item.id === 'todo')
    const line = todos
      .map(
        (item) =>
          `${item.status === 'done' ? '☑' : item.status === 'active' ? '▸' : '☐'} ${item.text}`
      )
      .join('\n')
    if (step) {
      step.detail = line
      step.status = 'done'
    } else {
      session.state.steps.push({
        id: 'todo',
        kind: 'todo',
        title: '拆解任务',
        detail: line,
        status: 'done',
        startedAt: Date.now(),
        endedAt: Date.now()
      })
    }
    this.touch(session)
  }

  private extractSummary(agent: Agent): string {
    const messages = agent.state?.messages ?? []
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const message = messages[i]
      if (message.role !== 'assistant') continue
      const text = (message.content ?? [])
        .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
        .map((block) => block.text)
        .join('\n')
        .trim()
      if (text) return clipText(text, MAX_STEP_DETAIL)
    }
    return ''
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
      this.sessions.set(record.id, {
        state: {
          id: record.id,
          status: interrupted ? 'cancelled' : record.status,
          task: record.task,
          workspace: record.workspace,
          startedAt: record.createdAt,
          endedAt: record.updatedAt,
          steps: Array.isArray(record.steps) ? record.steps : [],
          todos: Array.isArray(record.todos) ? record.todos : [],
          usage: record.usage ?? zeroUsage(),
          resumable: false,
          summary: record.summary,
          error: interrupted ? '应用重启，任务已中断' : record.error
        },
        agent: null,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        round: 0,
        turn: 0,
        turnTokens: new Map(),
        attachmentPaths: [],
        roundStartedAt: 0,
        roundCalls: 0,
        roundInput: 0,
        roundOutput: 0,
        roundCache: 0,
        pending: null,
        approvalChain: Promise.resolve(),
        taskTimer: null,
        running: false
      })
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
