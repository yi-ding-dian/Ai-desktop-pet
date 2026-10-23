/**
 * 任务模式（2026-10-23）：主进程与「任务」面板共用的纯类型。
 *
 * 本文件不 import 任何运行时（同 ipc/channels 的约定），preload / 渲染侧可安全引用。
 */

/** 任务状态：preparing = 取 Key / 建 Agent；waiting = 等用户确认（同时仍在 running 语义） */
export type AgentStatus =
  | 'idle'
  | 'preparing'
  | 'running'
  | 'waiting'
  | 'done'
  | 'failed'
  | 'cancelled'

export type AgentStepKind = 'text' | 'thinking' | 'tool' | 'todo' | 'error' | 'round' | 'stats'
export type AgentStepStatus = 'running' | 'done' | 'failed' | 'blocked'

/** 步骤流里的一行（工具调用 / 思考 / 文本 / 错误） */
/** 一次模型调用的用量（逐步累加到任务的 usage 上） */
export interface AgentUsage {
  /** 模型调用次数 */
  calls: number
  input: number
  output: number
  cacheRead: number
}

export interface AgentStep {
  id: string
  kind: AgentStepKind
  /** 属于第几轮模型调用（1 起；用于把思考/工具/正文归到同一次回复） */
  turn?: number
  /** 工具执行的完整命令（bash 用；行内展示 + 悬浮提示 + 右键复制） */
  command?: string
  /** kind='stats' 时：本轮用量汇总（含本轮结束时的上下文占用快照） */
  stats?: {
    calls: number
    input: number
    output: number
    cacheRead: number
    contextUsed?: number
    contextWindow?: number
  }
  /** 本次模型调用的 token 用量（只挂在正文或该轮首个工具步骤上） */
  tokens?: { input: number; output: number }
  /** 面板主文案，如「修改 src/auth.ts」 */
  title: string
  /** 次要信息（参数摘要 / 结果首行 / 错误原因） */
  detail?: string
  status: AgentStepStatus
  startedAt: number
  endedAt?: number
}

export type AgentTodoStatus = 'pending' | 'active' | 'done'

/** 模型自己维护的待办清单（`todo` 工具整表替换） */
export interface AgentTodoItem {
  id: string
  text: string
  status: AgentTodoStatus
}

/** 一次待确认操作（写文件 / 改文件 / 跑命令） */
export interface AgentApprovalRequest {
  id: string
  tool: string
  /** 确认卡标题，如「修改文件 src/auth.ts」 */
  title: string
  /** bash 的完整命令 */
  command?: string
  /** 涉及的文件（相对工作区） */
  path?: string
  /** diff 或参数摘要（已截断） */
  preview?: string
  /** 危险命令启发式命中：确认卡标红 */
  dangerous: boolean
  /** 到期时间戳（ms）；到点自动拒绝 */
  expiresAt: number
}

/** 一条附件（用户亲手附上；不复制，主进程按原路径读取） */
export interface AgentAttachment {
  path: string
  name: string
  /** 仅用于界面显示；主进程会按扩展名重新判定 */
  kind: 'image' | 'text' | 'other'
}

/** 面板渲染所需的完整状态（主进程节流推送） */
export interface AgentState {
  /** 任务 id（多任务列表里定位；空态为 ''） */
  id: string
  status: AgentStatus
  /** 本轮任务原话 */
  task: string
  /** 工作区绝对路径（用户通过原生对话框选定） */
  workspace: string
  startedAt?: number
  endedAt?: number
  steps: AgentStep[]
  todos: AgentTodoItem[]
  /** 任务累计用量 */
  usage: AgentUsage
  /** 当前上下文占用（最近一次请求的输入 + 缓存 + 输出）与模型窗口 */
  context?: { used: number; window: number }
  /** 当前任务还能不能继续追问（应用重启/被释放后为 false） */
  resumable: boolean
  approval?: AgentApprovalRequest
  /** 任务结束时的模型总结 */
  summary?: string
  /** 失败原因（已脱敏） */
  error?: string
}

/** 左侧任务列表的一行（不含步骤明细） */
export interface AgentTaskSummary {
  id: string
  task: string
  workspace: string
  createdAt: number
  updatedAt: number
  status: AgentStatus
}

/** agent:start 的入参 */
export interface AgentStartPayload {
  task: string
  workspace: string
  attachments?: AgentAttachment[]
}

/** agent:follow-up 的入参 */
export interface AgentFollowUpPayload {
  text: string
  attachments?: AgentAttachment[]
}

/** agent:approve 的入参（allow=false 即拒绝） */
export interface AgentApprovePayload {
  id: string
  allow: boolean
}
