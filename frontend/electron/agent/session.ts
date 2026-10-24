/** 任务服务的会话模型、常量与通用小工具。 */
import type { Agent } from '@earendil-works/pi-agent-core'
import type {
  AgentState,
  AgentStep,
  AgentUsage
} from './types'

/** 确认卡等待上限（ms）：到点按拒绝处理 */
export const APPROVAL_TIMEOUT_MS = 120_000
/** 单任务单轮总时长上限（ms） */
export const TASK_TIMEOUT_MS = 30 * 60 * 1000
/** 步骤数量上限（超出丢最旧的已结束步骤） */
export const MAX_STEPS = 200
/** 单条步骤正文上限（字符） */
export const MAX_STEP_DETAIL = 12_000
/** 状态推送节流（ms） */
export const PUSH_THROTTLE_MS = 120
/** 落盘防抖（ms） */
export const SAVE_DEBOUNCE_MS = 1500
/** 单轮最多附件数（与对话模式一致） */
export const MAX_ATTACHMENTS = 3
/** 图片附件上限（字节）与文本附件内联上限（字符） */
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024
export const MAX_INLINE_TEXT = 20_000
export const IMAGE_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif'
}

/** 最多保留多少个「可续聊」的 Agent（超出按最久未用释放，只影响续聊，不影响回看） */
export const MAX_LIVE_AGENTS = 5

export interface LlmKeyPayload {
  key: string
  baseUrl: string
  model: string
}

export type StateListener = (state: AgentState) => void
export type TasksListener = (tasks: import('./types').AgentTaskSummary[]) => void

export interface PendingApproval {
  id: string
  timer: NodeJS.Timeout
  resolve: (allow: boolean) => void
}

/** 一个任务的运行期状态（Agent 重启后为 null，仅可回看） */
export interface Session {
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

export function zeroUsage(): AgentUsage {
  return { calls: 0, input: 0, output: 0, cacheRead: 0 }
}

export function emptyState(): AgentState {
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
export function sanitizeError(text: string): string {
  return text
    .replace(/sk-[A-Za-z0-9_-]{6,}/g, 'sk-***')
    .replace(/Bearer\s+[A-Za-z0-9._-]{6,}/gi, 'Bearer ***')
    .slice(0, 1000)
}

export function clipText(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`
}

/** 新建一个空白会话（start 与懒加载各用一次）。 */
export function createSession(id: string, task: string, workspace: string, now: number): Session {
  return {
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
    roundStartedAt: now,
    roundCalls: 0,
    roundInput: 0,
    roundOutput: 0,
    roundCache: 0,
    pending: null,
    approvalChain: Promise.resolve(),
    taskTimer: null,
    running: true
  }
}

/** 从落盘记录恢复（Agent 不恢复，只回看）。 */
export function restoreSession(record: {
  id: string
  status: AgentState['status']
  task: string
  workspace: string
  createdAt: number
  updatedAt: number
  steps?: AgentStep[]
  todos?: AgentState['todos']
  usage?: AgentUsage
  summary?: string
  error?: string
}): Session {
  const interrupted =
    record.status === 'running' ||
    record.status === 'preparing' ||
    record.status === 'waiting'
  return {
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
  }
}
