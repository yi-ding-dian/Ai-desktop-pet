/**
 * 任务列表「管理」模式的选择状态（2026-10-26 从 TaskList 抽出）。
 *
 * 规则：运行中/排队中的任务被删除会中止，管理模式下不可选；
 * 列表刷新（删除、任务开始/结束）后自动剔除已失效的选中项。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { AgentTaskSummary } from '../../../../electron/ipc/channels'
import type { TimeGroup } from '../../shared/time'

/** 还在跑/排队的任务：删除会中止它，管理模式下不允许勾选（与对话页「回复中不可删」一致） */
function isActiveTask(status: AgentTaskSummary['status']): boolean {
  return (
    status === 'queued' ||
    status === 'preparing' ||
    status === 'running' ||
    status === 'waiting' ||
    status === 'planned'
  )
}

export interface TaskSelectionControls {
  selectMode: boolean
  selected: Set<string>
  selectableIds: Set<string>
  enter: () => void
  exit: () => void
  toggleItem: (id: string) => void
  toggleGroup: (group: TimeGroup<AgentTaskSummary>) => void
  toggleAll: () => void
}

export function useTaskSelection(groups: TimeGroup<AgentTaskSummary>[]): TaskSelectionControls {
  const [selectMode, setSelectMode] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(() => new Set())

  const selectableIds = useMemo(() => {
    const ids = new Set<string>()
    for (const group of groups) {
      for (const item of group.items) {
        if (!isActiveTask(item.status)) ids.add(item.id)
      }
    }
    return ids
  }, [groups])

  // 列表刷新后剔除已消失/已变得不可选的 id
  useEffect(() => {
    setSelected((prev) => {
      const next = new Set([...prev].filter((id) => selectableIds.has(id)))
      return next.size === prev.size ? prev : next
    })
  }, [selectableIds])

  // 管理模式下 Esc 退出
  useEffect(() => {
    if (!selectMode) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setSelectMode(false)
        setSelected(new Set())
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selectMode])

  const enter = useCallback((): void => setSelectMode(true), [])

  const exit = useCallback((): void => {
    setSelectMode(false)
    setSelected(new Set())
  }, [])

  const toggleItem = useCallback(
    (id: string): void => {
      if (!selectableIds.has(id)) return
      setSelected((prev) => {
        const next = new Set(prev)
        if (next.has(id)) next.delete(id)
        else next.add(id)
        return next
      })
    },
    [selectableIds]
  )

  const toggleGroup = useCallback(
    (group: TimeGroup<AgentTaskSummary>): void => {
      const ids = group.items.map((item) => item.id).filter((id) => selectableIds.has(id))
      setSelected((prev) => {
        const allSelected = ids.length > 0 && ids.every((id) => prev.has(id))
        const next = new Set(prev)
        for (const id of ids) {
          if (allSelected) next.delete(id)
          else next.add(id)
        }
        return next
      })
    },
    [selectableIds]
  )

  const toggleAll = useCallback((): void => {
    setSelected((prev) => {
      const ids = [...selectableIds]
      const allSelected = ids.length > 0 && ids.every((id) => prev.has(id))
      return allSelected ? new Set() : new Set(ids)
    })
  }, [selectableIds])

  return {
    selectMode,
    selected,
    selectableIds,
    enter,
    exit,
    toggleItem,
    toggleGroup,
    toggleAll
  }
}
