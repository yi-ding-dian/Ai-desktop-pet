/**
 * 任务删除（2026-10-26 从 TaskPanel 抽出）：单条与批量。
 *
 * 列表刷新由主进程 pushTasks 推送，这里只负责调用接口、统计失败与回调错误。
 * 批量删除串行执行（复用单条接口），避免几十个请求同时挤压主进程。
 */
import { useCallback } from 'react'
import { agentBridge } from '../agent-bridge'

export interface TaskDeletionOptions {
  /** 删除前调用（例如关掉右键菜单） */
  onStart?: () => void
  /** 删除失败时回调（单条给具体原因，批量给失败条数） */
  onError: (message: string) => void
}

export interface TaskDeletionControls {
  deleteTask: (id: string) => Promise<void>
  deleteTasks: (ids: string[]) => Promise<void>
}

export function useTaskDeletion({
  onStart,
  onError
}: TaskDeletionOptions): TaskDeletionControls {
  const deleteTask = useCallback(
    async (id: string): Promise<void> => {
      const api = agentBridge()
      if (!api) return
      onStart?.()
      const result = await api.deleteTask(id)
      if (!result.ok) onError(result.error ?? '删除失败')
    },
    [onStart, onError]
  )

  const deleteTasks = useCallback(
    async (ids: string[]): Promise<void> => {
      if (ids.length === 0) return
      if (!window.confirm(`删除选中的 ${ids.length} 个任务？`)) return
      const api = agentBridge()
      if (!api) return
      let failed = 0
      for (const id of ids) {
        try {
          const result = await api.deleteTask(id)
          if (!result.ok) failed += 1
        } catch {
          failed += 1
        }
      }
      if (failed > 0) onError(`有 ${failed} 个任务删除失败`)
    },
    [onError]
  )

  return { deleteTask, deleteTasks }
}
