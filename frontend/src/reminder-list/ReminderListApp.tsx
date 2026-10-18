/**
 * 提醒列表窗（reminder-list.html）：宠物右侧的未读提醒面板。
 *
 * 哑渲染面（照 bubble/board 先例）：不认识后端协议，只收主进程 IPC 的
 * `ReminderListOpenPayload`；点击条目/全部已读/展开紧凑条时把动作回传主进程，
 * 由宠物窗统一发 `ack_reminders`。
 *
 * 展示规则（2026-10-18 用户定稿）：
 *  - 未读视图：折叠只显示最新 2 条（最新在最下面）；右上角数字可点展开全部；
 *    展开后点面板外自动收回；右键菜单“全部已读”；
 *  - 时钟视图：标题右侧“时钟 + 绿点”入口，显示当天全部事件（已读 + 未读）+
 *    所有未到期计划（灰灯，2026-10-18），按到期时间正序；已读绿点、未读红点、
 *    未到期灰点；点未读标记已读，已读/未到期行不可点；点面板外回未读视图；
 *  - 未读视图底部居中：有未到期计划时显示灰点 +「未到时间 N 条」（无铃铛）；
 *    点击向下展开全部待提醒；展开后底部入口变「收起」，点面板外/失焦也可收回；
 *  - 没有未读、只有待办：透明小窗显示灰点 +「待办 N」并贴向宠物，点击向下展开；
 *  - 两侧空间都不够时主进程传 compact=true，只渲染紧凑条。
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactElement
} from 'react'
import { getPetBridge } from '../shared/pet-bridge'
import type {
  ReminderListActionPayload,
  ReminderListItemPayload,
  ReminderListOpenPayload,
  PetBridgeApi
} from '../../electron/ipc/channels'

/** 面板宽度自适应范围（px；与 electron/reminder-list/geometry.ts 对齐） */
const MIN_PANEL_WIDTH = 140
const MAX_PANEL_WIDTH = 220
/** 提醒正文最多显示多少个字，超出用省略号（悬浮 title 显示全文） */
const MAX_TEXT_CHARS = 10
/** 紧凑条尺寸（与 electron/reminder-list/geometry.ts 对齐） */
const COMPACT_WIDTH = 104
const COMPACT_HEIGHT = 38
/** 收起态最多显示的条数（最新 2 条；最新排在最下面） */
const COLLAPSED_COUNT = 2
/** 测量字体（与 CSS 对齐；用于自适应宽度） */
const TEXT_FONT = "13px system-ui, 'Noto Sans CJK SC', 'Source Han Sans SC', sans-serif"
const TIME_FONT = "10.5px system-ui, 'Noto Sans CJK SC', 'Source Han Sans SC', sans-serif"

/** 模块级缓存：Open 可能早于 React 订阅建立（主进程 READY 后立即下发） */
let lastPayload: ReminderListOpenPayload | null = null

const measureCanvas = document.createElement('canvas')
const measureCtx = measureCanvas.getContext('2d')

function measure(text: string, font: string): number {
  if (!measureCtx) return text.length * 13
  measureCtx.font = font
  return measureCtx.measureText(text).width
}

/** 正文超 10 字截断（按 Unicode 字符，避免把 emoji 劈开） */
function truncateText(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  const chars = [...clean]
  return chars.length > MAX_TEXT_CHARS ? chars.slice(0, MAX_TEXT_CHARS).join('') + '…' : clean
}

/** 按内容算面板首选宽度：字少就窄，最多约 10 个字；时间/按钮/底部灰灯兜底 */
function preferredWidth(
  items: ReminderListItemPayload[],
  pendingCount = 0,
  reserveDelete = false
): number {
  const textWidth = items.reduce(
    (max, item) => Math.max(max, measure(truncateText(item.text), TEXT_FONT)),
    0
  )
  const timeWidth = items.reduce(
    (max, item) =>
      Math.max(max, measure(item.timeText + (item.late ? ' 补报' : ''), TIME_FONT)),
    0
  )
  // 正文/时间两侧：item padding 7*2 + items padding 6*2；stage padding 6*2；
  // 时钟视图右侧预留 22px 给悬浮红 ×
  const deleteWidth = reserveDelete ? 22 : 0
  const content = Math.max(
    textWidth + 26 + 12 + deleteWidth,
    timeWidth + 26 + 12 + deleteWidth
  )
  // 铃铛 14 + 标题“提醒”24 + 时钟入口 20 + 计数 30 + 3 个 6px 间距 + 头部内边距 20 + stage 12
  const header = 14 + 6 + 24 + 6 + 20 + 6 + 30 + 20 + 12
  // 底部灰灯：铃铛 14 + 灰点 6 + 文本 + 箭头 9 + 3 个 5px 间距 + 左右内边距 12
  const footer =
    pendingCount > 0
      ? measure(`未到时间 ${pendingCount} 条`, TEXT_FONT) + 14 + 6 + 9 + 15 + 12
      : 0
  const width = Math.ceil(Math.max(content, header, footer))
  return Math.min(MAX_PANEL_WIDTH, Math.max(MIN_PANEL_WIDTH, width))
}

function listBridge(): PetBridgeApi['reminderList'] | undefined {
  try {
    return getPetBridge().reminderList
  } catch {
    return undefined
  }
}

export default function ReminderListApp(): ReactElement {
  const [payload, setPayload] = useState<ReminderListOpenPayload | null>(lastPayload)
  const [expanded, setExpanded] = useState(false)
  const stageRef = useRef<HTMLDivElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const bridge = listBridge()
    if (!bridge) return
    const off = bridge.onOpen((next) => {
      if (!next) return
      lastPayload = next
      setPayload(next)
      // 未读数回落到折叠数以内 / 切到时钟视图时自动收起扩展态
      if (next.mode !== 'unread' || next.unreadCount <= COLLAPSED_COUNT) setExpanded(false)
    })
    bridge.ready()
    return () => off()
  }, [])

  /** 尺寸上报：完整面板报首选宽度 + 实际内容高度；紧凑条报固定小尺寸 */
  const reportSize = useCallback(() => {
    const bridge = listBridge()
    if (!bridge) return
    if (payload?.compact) {
      bridge.reportSize({ width: COMPACT_WIDTH, height: COMPACT_HEIGHT })
      return
    }
    const panel = panelRef.current
    const stage = stageRef.current
    if (!panel && !stage) return
    // 量面板而不是 stage：stage 是 100% 窗口高度，量它会永远报告当前窗口高度（无法收缩）
    const height = panel ? panel.offsetHeight : (stage?.scrollHeight ?? 0)
    bridge.reportSize({
      width: preferredWidth(
        [...(payload?.items ?? []), ...(payload?.pendingItems ?? [])],
        payload?.pendingCount ?? 0,
        payload?.mode === 'today' || payload?.pendingExpanded === true
      ),
      height: Math.max(64, Math.ceil(height + 12))
    })
  }, [payload, expanded])

  useEffect(() => {
    const target = panelRef.current ?? stageRef.current
    if (!target) return
    const ro = new ResizeObserver(() => reportSize())
    ro.observe(target)
    reportSize()
    return () => ro.disconnect()
  }, [reportSize, expanded, payload])

  /**
   * 点击面板外（含切到别的应用）：
   *  - 时钟视图 → 回未读视图；
   *  - 未读视图灰灯展开 / 数字展开态 → 收起。
   */
  useEffect(() => {
    const mode = payload?.mode
    const pendingOpen = payload?.pendingExpanded === true
    if (!expanded && mode !== 'today' && !pendingOpen) return
    const close = (): void => {
      if (mode === 'today') {
        listBridge()?.action({ type: 'unread' })
        return
      }
      // 未读视图：灰灯展开 → 收起；右上角数字展开 → 收回 2 条
      if (pendingOpen) listBridge()?.action({ type: 'pending-collapse' })
      setExpanded(false)
    }
    const onPointerDown = (event: PointerEvent): void => {
      const panel = panelRef.current
      if (panel && !panel.contains(event.target as Node)) close()
    }
    window.addEventListener('blur', close)
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => {
      window.removeEventListener('blur', close)
      document.removeEventListener('pointerdown', onPointerDown, true)
    }
  }, [expanded, payload?.pendingExpanded, payload?.mode])

  const act = useCallback((action: ReminderListActionPayload) => {
    listBridge()?.action(action)
    console.log(`[reminder-list] action → ${action.type}${action.id ? ` ${action.id}` : ''}`)
  }, [])

  /** 右键菜单（主进程弹出“全部已读”） */
  const handleContextMenu = useCallback((event: ReactMouseEvent) => {
    event.preventDefault()
    event.stopPropagation()
    console.log('[reminder-list] contextmenu → 全部已读')
    listBridge()?.contextMenu()
  }, [])

  if (!payload)
    return <div className="reminder-list-stage" ref={stageRef} onContextMenu={handleContextMenu} />

  const {
    mode,
    items,
    unreadCount,
    pendingItems = [],
    pendingExpanded = false,
    pendingCount = 0,
    bellOnly = false,
    bellSide = 'right',
    compact
  } = payload

  // 常驻灰灯小球：没有未读、只有待提醒时占据一个很小的窗口；
  // 悬浮提示“存在待办事项”，点击展开成完整待提醒面板。
  if (bellOnly) {
    return (
      <div className="reminder-list-stage reminder-list-stage-bell" ref={stageRef}>
        <button
          type="button"
          className={`reminder-float-bell${
            bellSide === 'left' ? ' reminder-float-bell-left' : ''
          }`}
          data-testid="reminder-bell"
          title={`存在待办事项（${pendingCount} 条）`}
          aria-label="存在待办事项"
          onClick={() => act({ type: 'pending-expand' })}
        >
          <span className="reminder-pending-dot" aria-hidden="true" />
          <span className="reminder-float-bell-text">待办 {pendingCount}</span>
        </button>
      </div>
    )
  }

  if (compact) {
    return (
      <div
        className="reminder-list-stage reminder-list-stage-compact"
        ref={stageRef}
        onContextMenu={handleContextMenu}
      >
        <button
          type="button"
          className="reminder-compact"
          data-testid="reminder-compact"
          title="展开提醒列表"
          onClick={() => act({ type: 'expand' })}
        >
          <BellIcon />
          <span>{mode === 'today' ? `共 ${unreadCount} 条` : `待看 ${unreadCount} 条`}</span>
        </button>
      </div>
    )
  }

  // 未读快照是"新 → 旧"；反转为旧 → 新，让最新一条永远在最下面。
  // 时钟视图后端已是"旧 → 新"（按到期时间），直接使用；未读折叠只取最新 2 条。
  const ordered = mode === 'today' ? items : [...items].reverse()
  const shown = mode === 'today' ? ordered : expanded ? ordered : ordered.slice(-COLLAPSED_COUNT)
  const canExpand = mode === 'unread' && unreadCount > COLLAPSED_COUNT
  const toggleMode = (): void => act({ type: mode === 'today' ? 'unread' : 'history' })

  return (
    <div className="reminder-list-stage" ref={stageRef} onContextMenu={handleContextMenu}>
      <div
        className="reminder-panel"
        key={`${mode}-${pendingExpanded ? 'expanded' : 'collapsed'}`}
        ref={panelRef}
        data-testid="reminder-panel"
      >
        <div className="reminder-header">
          <BellIcon />
          <span className="reminder-title">提醒</span>
          <button
            type="button"
            className={`reminder-history-btn${mode === 'today' ? ' reminder-history-btn-active' : ''}`}
            data-testid="reminder-history"
            title={mode === 'today' ? '返回未读提醒' : '提醒记录（含未到时间）'}
            aria-label={mode === 'today' ? '返回未读提醒' : '提醒记录'}
            onClick={toggleMode}
          >
            <HistoryIcon />
            <span className="reminder-history-dot" aria-hidden="true" />
          </button>
          {mode === 'today' ? (
            unreadCount > 0 ? (
              <span className="reminder-count">{unreadCount}</span>
            ) : null
          ) : canExpand ? (
            <button
              type="button"
              className="reminder-count reminder-count-btn"
              data-testid="reminder-expand"
              title={expanded ? '收起' : '展开全部'}
              onClick={() => setExpanded((value) => !value)}
            >
              {unreadCount}
            </button>
          ) : unreadCount > 0 ? (
            <span className="reminder-count">{unreadCount}</span>
          ) : null}
        </div>

        <div
          className={`reminder-items${
            expanded || mode === 'today' ? ' reminder-items-scroll' : ''
          }`}
        >
          {mode === 'today' && shown.length === 0 ? (
            <div className="reminder-empty">还没有提醒</div>
          ) : (
            shown.map((item) => (
              <ReminderRow
                key={item.id}
                item={item}
                onAck={() => {
                  if (!item.pending && !item.acknowledged) {
                    act({ type: 'ack', id: item.id })
                  }
                }}
                onDelete={
                  mode === 'today'
                    ? () => act({ type: 'delete', id: item.id })
                    : undefined
                }
              />
            ))
          )}
        </div>

        {mode === 'unread' && pendingExpanded ? (
          <div className="reminder-pending-list" data-testid="reminder-pending-list">
            <div className="reminder-pending-label">待提醒</div>
            {pendingItems.length === 0 ? (
              <div className="reminder-empty">没有待提醒</div>
            ) : (
              pendingItems.map((item) => (
                <ReminderRow
                  key={`pending-${item.id}`}
                  item={item}
                  onAck={() => undefined}
                  onDelete={() => act({ type: 'delete', id: item.id })}
                />
              ))
            )}
          </div>
        ) : null}

        {pendingCount > 0 ? (
          <button
            type="button"
            className="reminder-pending-entry"
            data-testid="reminder-pending"
            aria-expanded={mode === 'today' || pendingExpanded}
            title={
              mode === 'today' || pendingExpanded ? '收起待提醒' : '展开待提醒'
            }
            onClick={() =>
              act(
                mode === 'today'
                  ? { type: 'unread' }
                  : pendingExpanded
                    ? { type: 'pending-collapse' }
                    : { type: 'pending-expand' }
              )
            }
          >
            {mode !== 'today' && !pendingExpanded ? (
              <span className="reminder-pending-dot" aria-hidden="true" />
            ) : null}
            <span>
              {mode === 'today' || pendingExpanded
                ? '收起'
                : `未到时间 ${pendingCount} 条`}
            </span>
            <span className="reminder-pending-chevron" aria-hidden="true">
              {mode === 'today' || pendingExpanded ? '▴' : '▾'}
            </span>
          </button>
        ) : null}
      </div>
    </div>
  )
}

function ReminderRow({
  item,
  onAck,
  onDelete
}: {
  item: ReminderListItemPayload
  onAck: () => void
  onDelete?: () => void
}): ReactElement {
  const pending = item.pending === true
  const row = (
    <button
      type="button"
      className={`reminder-item${item.acknowledged ? ' reminder-item-read' : ''}${
        pending ? ' reminder-item-pending' : ''
      }`}
      data-testid={`reminder-item-${item.id}`}
      data-acknowledged={item.acknowledged}
      data-pending={pending}
      aria-disabled={pending || item.acknowledged}
      title={
        pending
          ? `${item.text}\n（未到时间）`
          : `${item.text}\n（${item.acknowledged ? '已读' : '点击标记已读'}）`
      }
      onClick={onAck}
    >
      <span className="reminder-item-time">
        <span
          className={`reminder-unread-dot${item.acknowledged ? ' reminder-read-dot' : ''}${
            pending ? ' reminder-pending-dot' : ''
          }`}
          aria-hidden="true"
        />
        {item.timeText}
        {item.late ? <span className="reminder-late">补报</span> : null}
      </span>
      <span className="reminder-item-text">{truncateText(item.text)}</span>
    </button>
  )

  if (!onDelete) return row
  const deleteLabel = pending
    ? '移除这条待办事项'
    : item.acknowledged
      ? '删除这条已读事项'
      : '删除这条未读事项'
  return (
    <div className="reminder-item-row">
      {row}
      <button
        type="button"
        className="reminder-delete"
        data-testid={`reminder-delete-${item.id}`}
        title={deleteLabel}
        aria-label={deleteLabel}
        onClick={(event) => {
          event.stopPropagation()
          onDelete()
        }}
      >
        ×
      </button>
    </div>
  )
}

/** 提醒记录入口：时钟图标（绿点由外层 span 叠加，active 时高亮） */
function HistoryIcon(): ReactElement {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3.5 2" />
    </svg>
  )
}

function BellIcon(): ReactElement {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.7 21a2 2 0 0 1-3.4 0" />
    </svg>
  )
}
