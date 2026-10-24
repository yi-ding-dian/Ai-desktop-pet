// 任务模式类型统一从 channels 出口，渲染侧无需直接依赖主进程目录
export type {
  AgentApprovalRequest,
  AgentApprovePayload,
  AgentAttachment,
  AgentFollowUpPayload,
  AgentStartPayload,
  AgentState,
  AgentStep,
  AgentTaskSummary,
  AgentTodoItem
} from '../../agent/types'
