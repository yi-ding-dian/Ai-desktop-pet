/**
 * 任务模式「已发送消息」历史（2026-10-25）。
 *
 * 数据直接来自任务状态，不新增存储：
 *  - 初始任务：``state.task`` + ``state.startedAt``；定位目标是消息流顶部的任务起始行；
 *  - 后续追问：``steps`` 里 ``kind === 'round'`` 的步骤（title/startedAt）；定位目标是该轮气泡。
 * 只收用户消息，助手回复/工具步骤不进历史；顺序按发送顺序，最旧在前、最新在后。
 */
import type { AgentState } from '../../../../electron/ipc/channels'
import type { ComposerHistoryItem } from '../../message/chat-history'

/** 初始任务在消息流里的锚点 id（AgentFlow 的起始行） */
export const TASK_START_ID = 'task-start'

export interface TaskHistoryItem extends ComposerHistoryItem {
  kind: 'start' | 'round'
}

/** 从当前任务状态派生历史；无任务/空态返回空数组。 */
export function buildTaskHistory(state: AgentState | null | undefined): TaskHistoryItem[] {
  if (!state || !state.id) return []

  const items: TaskHistoryItem[] = []
  const taskText = (state.task ?? '').trim()
  if (taskText) {
    items.push({
      id: TASK_START_ID,
      text: state.task,
      at: typeof state.startedAt === 'number' ? state.startedAt : null,
      kind: 'start'
    })
  }

  const rounds = state.steps
    .map((step, index) => ({ step, index }))
    .filter(({ step }) => step.kind === 'round' && (step.title ?? '').trim().length > 0)
    // 步骤本身按发送顺序追加；时间都有效时再按时间排一次，缺失时间时保持原顺序。
    .sort((a, b) => {
      const atA = typeof a.step.startedAt === 'number' ? a.step.startedAt : null
      const atB = typeof b.step.startedAt === 'number' ? b.step.startedAt : null
      if (atA !== null && atB !== null && atA !== atB) return atA - atB
      return a.index - b.index
    })
    .map(({ step }) => ({
      id: step.id,
      text: step.title,
      at: typeof step.startedAt === 'number' ? step.startedAt : null,
      kind: 'round' as const
    }))

  return [...items, ...rounds]
}
