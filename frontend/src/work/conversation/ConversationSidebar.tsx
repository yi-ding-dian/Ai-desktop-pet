/**
 * 对话左栏（2026-10-24）：与任务模式同款布局——新建、按时间分组、切换、改名、删除、未读。
 */
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactElement
} from 'react'
import type { WorkConversationSummary } from '../../../electron/ipc/channels'

const WIDTH_KEY = 'pet.work.convSidebarWidth'
const COLLAPSED_KEY = 'pet.work.convSidebarCollapsed'
const DEFAULT_WIDTH = 216
const MIN_WIDTH = 150
const MAX_WIDTH = 360
const COLLAPSED_WIDTH = 36

interface Group {
  label: string
  items: WorkConversationSummary[]
}

function groupConversations(items: WorkConversationSummary[]): Group[] {
  const now = new Date()
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const startOfYesterday = startOfToday - 86_400_000
  const week = startOfToday - 6 * 86_400_000
  const buckets: Group[] = [
    { label: '今天', items: [] },
    { label: '昨天', items: [] },
    { label: '7 天内', items: [] },
    { label: '更早', items: [] }
  ]
  for (const item of items) {
    const at = item.updatedAt || item.createdAt
    const index = at >= startOfToday ? 0 : at >= startOfYesterday ? 1 : at >= week ? 2 : 3
    buckets[index].items.push(item)
  }
  return buckets.filter((bucket) => bucket.items.length > 0)
}

function relativeTime(ms: number, now: number): string {
  const diff = Math.max(0, now - ms)
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}分钟前`
  const date = new Date(ms)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export interface ConversationSidebarProps {
  items: WorkConversationSummary[]
  activeId: string
  /** 当前是未落库的草稿新对话（列表中还没有） */
  draft: boolean
  unread: Set<string>
  streaming: Set<string>
  onNew: () => void
  onSelect: (id: string) => void
  onRename: (id: string, title: string) => void
  onDelete: (id: string) => void
}

export default function ConversationSidebar({
  items,
  activeId,
  draft,
  unread,
  streaming,
  onNew,
  onSelect,
  onRename,
  onDelete
}: ConversationSidebarProps): ReactElement {
  const [width, setWidth] = useState<number>(() => {
    try {
      const raw = Number(localStorage.getItem(WIDTH_KEY))
      return Number.isFinite(raw) && raw >= MIN_WIDTH && raw <= MAX_WIDTH ? raw : DEFAULT_WIDTH
    } catch {
      return DEFAULT_WIDTH
    }
  })
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem(COLLAPSED_KEY) === '1'
    } catch {
      return false
    }
  })
  const [now, setNow] = useState(() => Date.now())
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingTitle, setEditingTitle] = useState('')
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null)

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    try {
      localStorage.setItem(WIDTH_KEY, String(width))
    } catch {
      /* 忽略 */
    }
  }, [width])

  useEffect(() => {
    try {
      localStorage.setItem(COLLAPSED_KEY, collapsed ? '1' : '0')
    } catch {
      /* 忽略 */
    }
  }, [collapsed])

  const groups = useMemo(() => groupConversations(items), [items])

  const startDrag = (event: ReactPointerEvent<HTMLDivElement>): void => {
    event.preventDefault()
    dragRef.current = { startX: event.clientX, startWidth: width }
    let latest = width
    const onMove = (moveEvent: PointerEvent): void => {
      const drag = dragRef.current
      if (!drag) return
      latest = Math.min(MAX_WIDTH, Math.max(60, drag.startWidth + moveEvent.clientX - drag.startX))
      setWidth(latest)
    }
    const onUp = (): void => {
      dragRef.current = null
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      if (latest < MIN_WIDTH) {
        setCollapsed(true)
        setWidth(DEFAULT_WIDTH)
      }
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  const submitRename = (id: string): void => {
    const title = editingTitle.trim()
    setEditingId(null)
    if (title) onRename(id, title)
  }

  if (collapsed) {
    return (
      <aside
        className="task-sidebar task-sidebar-collapsed"
        style={{ width: COLLAPSED_WIDTH }}
      >
        <button
          type="button"
          className="task-sidebar-expand"
          title="展开对话列表"
          aria-label="展开对话列表"
          onClick={() => setCollapsed(false)}
        >
          ▸
        </button>
      </aside>
    )
  }

  return (
    <aside className="task-sidebar" style={{ width }}>
      <button type="button" className="task-new" onClick={onNew}>
        <span aria-hidden="true">＋</span> 新对话
      </button>
      <div className="task-list pui-scroll">
        {draft ? (
          <button type="button" className="task-item task-item-active">
            <span className="task-item-dot task-item-dot-done" />
            <span className="task-item-text">新对话</span>
            <span className="task-item-time">草稿</span>
          </button>
        ) : null}
        {groups.length === 0 && !draft ? (
          <div className="task-list-empty">还没有对话</div>
        ) : (
          groups.map((group) => (
            <div className="task-group" key={group.label}>
              <div className="task-group-label">{group.label}</div>
              {group.items.map((item) => (
                <div
                  key={item.id}
                  className={`task-item${activeId === item.id && !draft ? ' task-item-active' : ''}${
                    unread.has(item.id) ? ' task-item-unread' : ''
                  }`}
                  role="button"
                  tabIndex={0}
                  title={`${item.title}\n${item.messageCount} 条消息`}
                  onClick={() => onSelect(item.id)}
                  onKeyDown={(event) => {
                    // 子输入框（改名）里的按键不触发整行选中
                    if (editingId === item.id) return
                    if (event.target !== event.currentTarget) return
                    if (event.key === 'Enter' || event.key === ' ') onSelect(item.id)
                  }}
                >
                  <span
                    className={`task-item-dot ${
                      streaming.has(item.id) ? 'task-item-dot-running' : 'task-item-dot-done'
                    }`}
                  />
                  {editingId === item.id ? (
                    <input
                      className="conv-rename-input"
                      value={editingTitle}
                      autoFocus
                      onClick={(event) => event.stopPropagation()}
                      onChange={(event) => setEditingTitle(event.target.value)}
                      onKeyDown={(event) => {
                        // 阻止冒泡到整行：Enter 只提交改名，不切换对话
                        event.stopPropagation()
                        if (event.key === 'Enter') {
                          event.preventDefault()
                          submitRename(item.id)
                        }
                        if (event.key === 'Escape') {
                          setEditingTitle('')
                          setEditingId(null)
                        }
                      }}
                      onBlur={() => submitRename(item.id)}
                    />
                  ) : (
                    <span className="task-item-text">{item.title}</span>
                  )}
                  <span className="task-item-time">
                    {relativeTime(item.updatedAt || item.createdAt, now)}
                  </span>
                  {unread.has(item.id) ? (
                    <span className="task-item-unread-dot" aria-label="有新回复" />
                  ) : null}
                  <span className="conv-item-actions">
                    <button
                      type="button"
                      className="conv-item-action"
                      title="重命名"
                      onClick={(event) => {
                        event.stopPropagation()
                        setEditingId(item.id)
                        setEditingTitle(item.title)
                      }}
                    >
                      ✎
                    </button>
                    <button
                      type="button"
                      className="conv-item-action"
                      title="删除对话"
                      onClick={(event) => {
                        event.stopPropagation()
                        onDelete(item.id)
                      }}
                    >
                      ×
                    </button>
                  </span>
                </div>
              ))}
            </div>
          ))
        )}
      </div>
      <div
        className="task-sidebar-resizer"
        role="separator"
        aria-orientation="vertical"
        aria-label="拖动调整对话列表宽度"
        onPointerDown={startDrag}
      />
    </aside>
  )
}
