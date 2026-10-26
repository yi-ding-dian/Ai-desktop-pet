/** 任务页左侧列表：按时间分组、可拖动宽度、可吸附折叠。 */
import {
  useEffect,
  useMemo,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactElement
} from 'react'
import type { AgentTaskSummary } from '../../../electron/ipc/channels'
import { MODE_LABELS } from './TaskModeSelector'
import { relativeTime, type TimeGroup } from '../shared/time'

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

export interface TaskListProps {
  groups: TimeGroup<AgentTaskSummary>[]
  collapsed: boolean
  /** 展开态的宽度（折叠态由本组件用固定窄条宽度） */
  width: number
  compose: boolean
  activeId?: string
  onNew: () => void
  onExpand: () => void
  onSelect: (id: string) => void
  onContextMenu: (id: string, x: number, y: number) => void
  /** 管理模式：批量删除（父级负责确认与刷新，逐条复用单条删除接口） */
  onDeleteMany: (ids: string[]) => void
  onResizeStart: (event: ReactPointerEvent<HTMLDivElement>) => void
}

/** 折叠后的窄条宽度 */
const COLLAPSED_WIDTH = 36

export default function TaskList({
  groups,
  collapsed,
  width,
  compose,
  activeId,
  onNew,
  onExpand,
  onSelect,
  onContextMenu,
  onDeleteMany,
  onResizeStart
}: TaskListProps): ReactElement {
  // 相对时间需要随时间推进刷新（"刚刚" → "n 分钟前" → "HH:MM"）
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(timer)
  }, [])

  // 管理模式（2026-10-26，与对话左栏同款）：运行中的任务不可选；列表推送刷新后剔除失效项
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

  useEffect(() => {
    setSelected((prev) => {
      const next = new Set([...prev].filter((id) => selectableIds.has(id)))
      return next.size === prev.size ? prev : next
    })
  }, [selectableIds])

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

  const exitSelectMode = (): void => {
    setSelectMode(false)
    setSelected(new Set())
  }

  const toggleItem = (id: string): void => {
    if (!selectableIds.has(id)) return
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const toggleGroup = (group: TimeGroup<AgentTaskSummary>): void => {
    const ids = group.items.map((item) => item.id).filter((id) => selectableIds.has(id))
    const allSelected = ids.length > 0 && ids.every((id) => selected.has(id))
    setSelected((prev) => {
      const next = new Set(prev)
      for (const id of ids) {
        if (allSelected) next.delete(id)
        else next.add(id)
      }
      return next
    })
  }

  const toggleAll = (): void => {
    const ids = [...selectableIds]
    const allSelected = ids.length > 0 && ids.every((id) => selected.has(id))
    setSelected(allSelected ? new Set() : new Set(ids))
  }

  return (
    <aside
      className={`task-sidebar${collapsed ? ' task-sidebar-collapsed' : ''}`}
      style={{ width: collapsed ? COLLAPSED_WIDTH : width }}
    >
      {collapsed ? (
        <button
          type="button"
          className="task-sidebar-expand"
          title="展开任务列表"
          aria-label="展开任务列表"
          onClick={onExpand}
        >
          ▸
        </button>
      ) : (
        <>
          <div className="conv-sidebar-top">
            <button
              type="button"
              className={`task-new${compose ? ' task-new-active' : ''}`}
              onClick={onNew}
            >
              <span aria-hidden="true">＋</span> 新任务
            </button>
            <button
              type="button"
              className={`conv-batch-toggle${selectMode ? ' conv-batch-toggle-on' : ''}`}
              title={selectMode ? '退出管理' : '任务管理'}
              onClick={() => (selectMode ? exitSelectMode() : setSelectMode(true))}
            >
              管理
            </button>
          </div>
          <div className="task-list pui-scroll">
            {groups.length === 0 ? (
              <div className="task-list-empty">还没有任务</div>
            ) : (
              groups.map((group) => {
                const groupIds = group.items
                  .map((item) => item.id)
                  .filter((id) => selectableIds.has(id))
                const groupAllSelected =
                  groupIds.length > 0 && groupIds.every((id) => selected.has(id))
                return (
                  <div className="task-group" key={group.label}>
                    <div className="task-group-label">
                      <span>{group.label}</span>
                      {selectMode && groupIds.length > 0 ? (
                        <button
                          type="button"
                          className="conv-group-select"
                          title={groupAllSelected ? '取消本组选择' : '选中本组全部'}
                          onClick={() => toggleGroup(group)}
                        >
                          {groupAllSelected ? '取消' : '全选'}
                        </button>
                      ) : null}
                    </div>
                    {group.items.map((item) => {
                      const selectable = selectableIds.has(item.id)
                      const checked = selected.has(item.id)
                      return (
                        <button
                          type="button"
                          key={item.id}
                          className={`task-item${
                            !compose && !selectMode && activeId === item.id
                              ? ' task-item-active'
                              : ''
                          }${item.hasUpdate ? ' task-item-unread' : ''}${
                            selectMode ? ' conv-select-mode' : ''
                          }${selectMode && checked ? ' conv-item-selected' : ''}${
                            selectMode && !selectable ? ' conv-item-disabled' : ''
                          }`}
                          title={
                            selectMode
                              ? selectable
                                ? `${item.task}\n点击选择/取消`
                                : `${item.task}\n运行中，暂不能删除`
                              : `${item.task}\n${MODE_LABELS[item.mode]} · ${item.workspace}`
                          }
                          onClick={() => {
                            if (selectMode) toggleItem(item.id)
                            else onSelect(item.id)
                          }}
                          onContextMenu={(event) => {
                            event.preventDefault()
                            if (selectMode) return
                            event.stopPropagation()
                            onContextMenu(item.id, event.clientX, event.clientY)
                          }}
                        >
                          {selectMode ? (
                            <span
                              className={`conv-check${checked ? ' conv-check-on' : ''}`}
                              aria-hidden="true"
                            >
                              {checked ? '✓' : ''}
                            </span>
                          ) : (
                            <span className={`task-item-dot task-item-dot-${item.status}`} />
                          )}
                          <span className="task-item-text">{item.task}</span>
                          {item.waitingFor ? (
                            <span
                              className={`task-item-badge task-item-badge-${item.waitingFor}`}
                            >
                              {item.waitingFor === 'question' ? '待回答' : '待确认'}
                            </span>
                          ) : item.queuePosition !== undefined ? (
                            <span className="task-item-badge">排队 {item.queuePosition}</span>
                          ) : null}
                          <span className="task-item-time">
                            {relativeTime(item.updatedAt || item.createdAt, now)}
                          </span>
                          {item.hasUpdate ? (
                            <span
                              className="task-item-unread-dot"
                              aria-label="任务已完成，点击查看"
                            />
                          ) : null}
                        </button>
                      )
                    })}
                  </div>
                )
              })
            )}
          </div>
          {selectMode ? (
            <div className="conv-batch-bar">
              <span className="conv-batch-count">已选 {selected.size} 项</span>
              <div className="conv-batch-actions">
                <button type="button" className="conv-batch-btn" onClick={toggleAll}>
                  {selected.size > 0 && selected.size === selectableIds.size
                    ? '取消全选'
                    : '全选'}
                </button>
                <button
                  type="button"
                  className="conv-batch-btn conv-batch-btn-danger"
                  disabled={selected.size === 0}
                  onClick={() => onDeleteMany([...selected])}
                >
                  删除{selected.size > 0 ? `（${selected.size}）` : ''}
                </button>
                <button type="button" className="conv-batch-btn" onClick={exitSelectMode}>
                  完成
                </button>
              </div>
            </div>
          ) : null}
          <div
            className="task-sidebar-resizer"
            role="separator"
            aria-orientation="vertical"
            aria-label="拖动调整任务列表宽度"
            onPointerDown={onResizeStart}
          />
        </>
      )}
    </aside>
  )
}
