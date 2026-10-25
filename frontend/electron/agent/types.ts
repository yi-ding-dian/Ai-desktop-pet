/**
 * 任务模式（2026-10-23）：主进程与「任务」面板共用的纯类型。
 *
 * 本文件不 import 任何运行时（同 ipc/channels 的约定），preload / 渲染侧可安全引用。
 */

/**
 * 执行模式（2026-10-24）：
 * - standard：工作区内读写删免确认；工作区外不可逆操作确认；bash 一律确认；
 * - auto：除致命命令外全部免确认；
 * - plan：只读，只产出计划与待办，结束后停在 planned。
 */
export type ExecutionMode = 'standard' | 'auto' | 'plan'

/** 任务状态：preparing = 取 Key / 建 Agent；waiting = 等用户处理（确认/回答） */
export type AgentStatus =
  | 'idle'
  | 'queued'
  | 'preparing'
  | 'running'
  | 'waiting'
  | 'planned'
  | 'done'
  | 'failed'
  | 'cancelled'

/** 任务在等待什么：确认卡或提问卡 */
export type AgentWaitingKind = 'approval' | 'question'

/** 后台任务需要用户处理（主进程弹通知 / 任务列表角标） */
export interface AgentAttention {
  id: string
  task: string
  kind: AgentWaitingKind
}

export type AgentStepKind = 'text' | 'thinking' | 'tool' | 'todo' | 'error' | 'round' | 'stats'
export type AgentStepStatus = 'running' | 'done' | 'failed' | 'blocked'

/** 步骤流里的一行（工具调用 / 思考 / 文本 / 错误） */
/** 一次模型调用的用量（逐步累加到任务的 usage 上） */
export interface AgentUsage {
  /** 模型调用次数 */
  calls: number
  /** 未命中缓存的输入 token */
  input: number
  output: number
  /** 命中缓存的输入 token */
  cacheRead: number
  /** 估算费用（人民币元；模型未知时为 0） */
  cost: number
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
    /** 本轮估算费用（人民币元；模型未知时缺省） */
    cost?: number
    /** 本轮所有模型调用的生成时长合计（turn_start → message_end，不含工具执行） */
    generationMs?: number
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

/** 联网搜索/抓取的结构化来源（与对话模式的 sources 同构，悬浮卡片共用） */
export interface AgentSourceItem {
  index: number
  title: string
  url: string
  snippet: string
  site_name: string
  date: string
}

/** 一次「向用户提问」（ask_user 工具）：模型阻塞等待用户选择或自由输入 */
export interface AgentQuestionRequest {
  id: string
  /** 要问用户的问题（一两句话） */
  question: string
  /** 2–4 个选项（用户也可以自行输入“其他”） */
  options: string[]
  /** 发起时间（ms），面板显示用 */
  createdAt: number
}

/** ask_user 的回答：answer 为空串表示用户没答（取消/中止） */
export interface AgentQuestionAnswerPayload {
  id: string
  answer: string
}

/** 切换执行模式 */
export interface AgentSetModePayload {
  id: string
  mode: ExecutionMode
}

/** 计划任务「按此执行」：只能切到可执行的模式 */
export interface AgentExecutePlanPayload {
  id: string
  mode: Exclude<ExecutionMode, 'plan'>
}

/** 一次待确认操作（写文件 / 改文件 / 跑命令） */
export interface AgentApprovalRequest {
  id: string
  tool: string
  /** 确认卡标题，如「修改文件 src/auth.ts」 */
  title: string
  /** bash 的完整命令 */
  command?: string
  /** 涉及的文件（工作区内相对路径，或工作区外绝对路径） */
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
  /** 本任务实际使用的模型 id（旧记录可能没有） */
  model?: string
  /** 当前执行模式 */
  mode: ExecutionMode
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
  /** 联网搜索/抓取收集到的来源（按 URL 去重；引用悬浮卡片用） */
  sources?: AgentSourceItem[]
  approval?: AgentApprovalRequest
  /** 当前等待用户回答的问题（ask_user；回答后清空） */
  question?: AgentQuestionRequest
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
  /** 当前执行模式 */
  mode: ExecutionMode
  /** 正在等用户处理什么（确认/回答）；不在 waiting 时缺省 */
  waitingFor?: AgentWaitingKind
  /** 排队位置（1 起）；不在排队时缺省 */
  queuePosition?: number
  /** 后台完成、用户尚未查看（点开后清除；不跨应用重启保留） */
  hasUpdate?: boolean
}

/**
 * 任务页顶部的模型/余额状态（2026-10-25）。
 *
 * 余额只对 DeepSeek 官方端点可用；自定义端点或未配置 Key 时
 * ``balanceSupported=false``，主进程保留上一次成功值并在 ``code/message`` 里说明原因。
 */
export interface AgentLlmStatus {
  /** 配置里的模型名（任务运行中应优先用 AgentState.model） */
  model: string
  configured: boolean
  /** 任务页顶部显示项（设置 → 任务；默认全部关闭） */
  showBalance: boolean
  showModel: boolean
  showCost: boolean
  /** 下次新任务使用的思考强度（low / high / max） */
  thinkingLevel: string
  /** 当前模型支持的思考强度（顶部菜单只列这些） */
  thinkingLevels: string[]
  balanceSupported: boolean
  currency: string
  total: number | null
  granted: number | null
  toppedUp: number | null
  /** 最近一次成功拿到余额的时间（0 = 从未成功） */
  updatedAt: number
  /** 最近一次刷新结果：空串 = 成功 */
  code: string
  message: string
}

/** 工作区输入校验结果（agent:validate-workspace） */
export interface AgentWorkspaceCheck {
  ok: boolean
  /** 校验通过后的 realpath */
  path?: string
  error?: string
}

/** agent:start 的入参 */
export interface AgentStartPayload {
  task: string
  workspace: string
  attachments?: AgentAttachment[]
  /** 执行模式；缺省 standard（旧渲染侧不带也能用） */
  mode?: ExecutionMode
}

/** 宠物窗 → 任务页的草稿（2026-10-25：带文件的宠物消息统一转任务模式） */
export interface AgentTaskDraftPayload {
  /** 主进程补的草稿 id（同一份草稿只自动启动一次） */
  id?: string
  /** 宠物输入条里的文字（可空 = 只带文件） */
  text: string
  /** 本轮附件（主进程会再过滤一次） */
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
