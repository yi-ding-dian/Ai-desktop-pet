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
import { groupByTime, relativeTime, type TimeGroup } from '../shared/time'

const WIDTH_KEY = 'pet.work.convSidebarWidth'
const COLLAPSED_KEY = 'pet.work.convSidebarCollapsed'
const DEFAULT_WIDTH = 216
const MIN_WIDTH = 150
const MAX_WIDTH = 360
const COLLAPSED_WIDTH = 36

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
  /** 批量删除（父级负责确认与刷新，逐条复用单条删除接口） */
  onDeleteMany: (ids: string[]) => void
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
  onDelete,
  onDeleteMany
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

  const pet = useMemo(() => items.find((item) => item.kind === 'pet'), [items])
  const groups = useMemo(
    () =>
      groupByTime(
        items.filter((item) => item.kind !== 'pet'),
        (item) => item.updatedAt || item.createdAt
      ),
    [items]
  )

  // 批量管理（2026-10-26）：宠物会话固定不可删，正在回复的对话后端会拒绝删除——两者都不可选
  const [selectMode, setSelectMode] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const selectableIds = useMemo(() => {
    const ids = new Set<string>()
    for (const item of items) {
      if (item.kind !== 'pet' && !streaming.has(item.id)) ids.add(item.id)
    }
    return ids
  }, [items, streaming])

  // 列表刷新后剔除已消失/已变得不可选的 id（删除成功、对话开始回复等）
  useEffect(() => {
    setSelected((prev) => {
      const next = new Set([...prev].filter((id) => selectableIds.has(id)))
      return next.size === prev.size ? prev : next
    })
  }, [selectableIds])

  // 批量模式下 Esc 退出
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

  const toggleGroup = (group: TimeGroup<WorkConversationSummary>): void => {
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
      <div className="conv-sidebar-top">
        <button type="button" className="task-new" onClick={onNew}>
          <span aria-hidden="true">＋</span> 新对话
        </button>
        <button
          type="button"
          className={`conv-batch-toggle${selectMode ? ' conv-batch-toggle-on' : ''}`}
          title={selectMode ? '退出管理' : '会话管理'}
          onClick={() => (selectMode ? exitSelectMode() : setSelectMode(true))}
        >
          管理
        </button>
      </div>
      <div className="task-list pui-scroll">
        {pet ? (
          <button
            type="button"
            className={`task-item conv-pet-item${
              activeId === pet.id && !draft ? ' task-item-active' : ''
            }${unread.has(pet.id) ? ' task-item-unread' : ''}`}
            title="和宠物的固定会话（置顶，不可删除）"
            onClick={() => onSelect(pet.id)}
          >
            <span
              className={`task-item-dot ${
                streaming.has(pet.id) ? 'task-item-dot-running' : 'task-item-dot-done'
              }`}
            />
            <span className="task-item-text">宠物会话</span>
            <span className="conv-pet-badge">宠物</span>
            {unread.has(pet.id) ? (
              <span className="task-item-unread-dot" aria-label="有新回复" />
            ) : null}
          </button>
        ) : null}
        {draft ? (
          <button type="button" className="task-item task-item-active">
            <span className="task-item-dot task-item-dot-done" />
            <span className="task-item-text">新对话</span>
            <span className="task-item-time">草稿</span>
          </button>
        ) : null}
        {groups.length === 0 && !draft && !pet ? (
          <div className="task-list-empty">还没有对话</div>
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
                    <div
                      key={item.id}
                      className={`task-item${activeId === item.id && !draft ? ' task-item-active' : ''}${
                        unread.has(item.id) ? ' task-item-unread' : ''
                      }${selectMode ? ' conv-select-mode' : ''}${
                        selectMode && checked ? ' conv-item-selected' : ''
                      }${selectMode && !selectable ? ' conv-item-disabled' : ''}`}
                      role="button"
                      tabIndex={0}
                      title={
                        selectMode
                          ? selectable
                            ? `${item.title}\n点击选择/取消`
                            : `${item.title}\n正在回复中，暂不能删除`
                          : `${item.title}\n${item.messageCount} 条消息`
                      }
                      onClick={() => {
                        if (selectMode) toggleItem(item.id)
                        else onSelect(item.id)
                      }}
                      onKeyDown={(event) => {
                        // 子输入框（改名）里的按键不触发整行选中
                        if (editingId === item.id) return
                        if (event.target !== event.currentTarget) return
                        if (event.key === 'Enter' || event.key === ' ') {
                          if (selectMode) toggleItem(item.id)
                          else onSelect(item.id)
                        }
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
                        <span
                          className={`task-item-dot ${
                            streaming.has(item.id)
                              ? 'task-item-dot-running'
                              : 'task-item-dot-done'
                          }`}
                        />
                      )}
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
                      {selectMode ? null : (
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
                      )}
                    </div>
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
              {selected.size > 0 && selected.size === selectableIds.size ? '取消全选' : '全选'}
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
        aria-label="拖动调整对话列表宽度"
        onPointerDown={startDrag}
      />
    </aside>
  )
}
