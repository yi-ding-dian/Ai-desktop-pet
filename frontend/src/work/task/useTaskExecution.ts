/**
 * 任务执行（2026-10-26 从 TaskPanel 抽出）：
 * 新任务启动、续聊发送、切换任务、审批 / 回答 / 按计划执行。
 *
 * 只负责发请求与错误提示；任务状态、列表刷新由主进程推送。
 */
import { useCallback } from 'react'
import type {
  AgentAttachment,
  AgentState,
  ExecutionMode,
  PickedFile
} from '../../../electron/ipc/channels'
import { attachmentKind } from '../message/AttachmentStrip'
import { agentBridge } from './agent-bridge'
import { errorText } from './error-text'

export interface TaskExecutionOptions {
  composeMode: ExecutionMode
  task: string
  reply: string
  workspace: string
  attachments: PickedFile[]
  state: AgentState | null
  checkWorkspace: (raw: string) => Promise<boolean>
  clearWsTimer: () => void
  clearAttachments: () => void
  toAgentAttachments: () => AgentAttachment[]
  onError: (message: string | null) => void
  onReplyChange: (value: string) => void
  onTaskChange: (value: string) => void
  onComposeChange: (value: boolean) => void
  onFileNotice: (message: string | null) => void
  /** 切换任务后恢复「跟随到底」 */
  stickToBottom: () => void
}

export interface TaskExecutionControls {
  startWith: (text: string, files: PickedFile[], targetWorkspace: string) => Promise<void>
  start: () => Promise<void>
  send: () => Promise<void>
  selectTask: (id: string) => Promise<void>
  approve: (allow: boolean) => void
  changeMode: (mode: ExecutionMode) => Promise<void>
  answerQuestion: (id: string, answer: string) => Promise<void>
  executePlan: (mode: 'standard' | 'auto') => Promise<void>
}

export function useTaskExecution({
  composeMode,
  task,
  reply,
  workspace,
  attachments,
  state,
  checkWorkspace,
  clearWsTimer,
  clearAttachments,
  toAgentAttachments,
  onError,
  onReplyChange,
  onTaskChange,
  onComposeChange,
  onFileNotice,
  stickToBottom
}: TaskExecutionOptions): TaskExecutionControls {
  /** 真正启动任务（草稿和手动「开始」共用；失败时保留输入与附件） */
  const startWith = useCallback(
    async (text: string, files: PickedFile[], targetWorkspace: string): Promise<void> => {
      const api = agentBridge()
      if (!api) {
        onError('任务模式不可用：请重启应用')
        return
      }
      const trimmed = text.trim() || (files.length > 0 ? '帮我看看这些文件' : '')
      if (!trimmed) {
        onError('先说说要做什么')
        return
      }
      clearWsTimer()
      const workspaceOk = await checkWorkspace(targetWorkspace)
      if (!workspaceOk) return
      onError(null)
      let result: { ok: boolean; error?: string }
      try {
        result = await api.start({
          task: trimmed,
          workspace: targetWorkspace,
          attachments: files.map((file) => ({
            path: file.path,
            name: file.name,
            kind: attachmentKind(file.name)
          })),
          mode: composeMode
        })
      } catch (err) {
        onError(errorText(err))
        return
      }
      if (!result.ok) {
        onError(result.error ?? '启动失败')
        return
      }
      onTaskChange('')
      clearAttachments()
      onComposeChange(false)
    },
    [composeMode, clearAttachments, checkWorkspace, clearWsTimer, onError, onTaskChange, onComposeChange]
  )

  const start = useCallback(async (): Promise<void> => {
    await startWith(task, attachments, workspace)
  }, [startWith, task, attachments, workspace])

  const send = useCallback(async (): Promise<void> => {
    const api = agentBridge()
    const text = reply.trim()
    if (!api || !text) return
    onError(null)
    const result = await api.followUp({ text, attachments: toAgentAttachments() })
    if (!result.ok) {
      onError(result.error ?? '发送失败')
      return
    }
    onReplyChange('')
    clearAttachments()
  }, [reply, toAgentAttachments, clearAttachments, onError, onReplyChange])

  const selectTask = useCallback(
    async (id: string): Promise<void> => {
      const api = agentBridge()
      if (!api) return
      const result = await api.select(id)
      if (!result.ok) {
        onError(result.error ?? '切换失败')
        return
      }
      onError(null)
      onComposeChange(false)
      // 重新选同一个任务时 state.id 不变，也要清掉上次留下的历史选中文本/附件
      onReplyChange('')
      clearAttachments()
      onFileNotice(null)
      stickToBottom()
    },
    [clearAttachments, onError, onComposeChange, onReplyChange, onFileNotice, stickToBottom]
  )

  const approve = useCallback(
    (allow: boolean): void => {
      const approval = state?.approval
      if (!approval) return
      agentBridge()?.approve({ id: approval.id, allow })
    },
    [state?.approval]
  )

  const changeMode = useCallback(
    async (mode: ExecutionMode): Promise<void> => {
      const api = agentBridge()
      const id = state?.id
      if (!api || !id) return
      const result = await api.setMode({ id, mode })
      if (!result.ok) onError(result.error ?? '切换模式失败')
    },
    [state?.id, onError]
  )

  const answerQuestion = useCallback(
    async (id: string, answer: string): Promise<void> => {
      const api = agentBridge()
      if (!api) return
      const result = await api.answerQuestion({ id, answer })
      if (!result.ok) onError(result.error ?? '提交失败')
    },
    [onError]
  )

  const executePlan = useCallback(
    async (mode: 'standard' | 'auto'): Promise<void> => {
      const api = agentBridge()
      const id = state?.id
      if (!api || !id) return
      onError(null)
      const result = await api.executePlan({ id, mode })
      if (!result.ok) onError(result.error ?? '执行失败')
    },
    [state?.id, onError]
  )

  return {
    startWith,
    start,
    send,
    selectTask,
    approve,
    changeMode,
    answerQuestion,
    executePlan
  }
}
