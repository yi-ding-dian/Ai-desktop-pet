/** 任务页左侧列表：按时间分组、可拖动宽度、可吸附折叠。 */
import {
  useEffect,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactElement
} from 'react'
import type { AgentTaskSummary } from '../../../electron/ipc/channels'

export interface TaskGroup {
  label: string
  items: AgentTaskSummary[]
}

/** 任务列表按时间分组：今天 / 昨天 / 7 天内 / 更早 */
export function groupTasks(tasks: AgentTaskSummary[]): TaskGroup[] {
  const now = new Date()
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const startOfYesterday = startOfToday - 86_400_000
  const week = startOfToday - 6 * 86_400_000
  const buckets: TaskGroup[] = [
    { label: '今天', items: [] },
    { label: '昨天', items: [] },
    { label: '7 天内', items: [] },
    { label: '更早', items: [] }
  ]
  for (const task of tasks) {
    const at = task.updatedAt || task.createdAt
    const index = at >= startOfToday ? 0 : at >= startOfYesterday ? 1 : at >= week ? 2 : 3
    buckets[index].items.push(task)
  }
  return buckets.filter((bucket) => bucket.items.length > 0)
}

export interface TaskListProps {
  groups: TaskGroup[]
  collapsed: boolean
  /** 展开态的宽度（折叠态由本组件用固定窄条宽度） */
  width: number
  compose: boolean
  activeId?: string
  onNew: () => void
  onExpand: () => void
  onSelect: (id: string) => void
  onContextMenu: (id: string, x: number, y: number) => void
  onResizeStart: (event: ReactPointerEvent<HTMLDivElement>) => void
}

/** 折叠后的窄条宽度 */
const COLLAPSED_WIDTH = 36

/** 任务项右侧时间：刚刚 / n 分钟前 / 超过 1 小时显示 HH:MM */
function relativeTime(ms: number, now: number): string {
  const diff = Math.max(0, now - ms)
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}分钟前`
  const date = new Date(ms)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

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
  onResizeStart
}: TaskListProps): ReactElement {
  // 相对时间需要随时间推进刷新（"刚刚" → "n 分钟前" → "HH:MM"）
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(timer)
  }, [])

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
          <button
            type="button"
            className={`task-new${compose ? ' task-new-active' : ''}`}
            onClick={onNew}
          >
            <span aria-hidden="true">＋</span> 新任务
          </button>
          <div className="task-list pui-scroll">
            {groups.length === 0 ? (
              <div className="task-list-empty">还没有任务</div>
            ) : (
              groups.map((group) => (
                <div className="task-group" key={group.label}>
                  <div className="task-group-label">{group.label}</div>
                  {group.items.map((item) => (
                    <button
                      type="button"
                      key={item.id}
                      className={`task-item${
                        !compose && activeId === item.id ? ' task-item-active' : ''
                      }${item.hasUpdate ? ' task-item-unread' : ''}`}
                      title={`${item.task}\n${item.workspace}`}
                      onClick={() => onSelect(item.id)}
                      onContextMenu={(event) => {
                        event.preventDefault()
                        event.stopPropagation()
                        onContextMenu(item.id, event.clientX, event.clientY)
                      }}
                    >
                      <span className={`task-item-dot task-item-dot-${item.status}`} />
                      <span className="task-item-text">{item.task}</span>
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
                  ))}
                </div>
              ))
            )}
          </div>
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
