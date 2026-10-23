/**
 * 工作窗「任务」标签页（2026-10-23）。
 *
 * 布局：左侧任务列表 + 右侧消息流（我右 / 模型左），底部输入条。
 * 数据：任务状态来自主进程 agent 域（多 Session），面板挂载时补拉，之后靠推送刷新。
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactElement
} from 'react'
import { renderMarkdownWithCitations } from '../board/markdown'
import type {
  AgentAttachment,
  AgentState,
  AgentStep,
  AgentTaskSummary,
  AgentTodoItem,
  PickedFile
} from '../../electron/ipc/channels'
import { Textarea } from '../shared/ui/components/Textarea'
import { getPetBridge } from '../shared/pet-bridge'
import {
  MAX_ATTACHMENTS,
  filesBridge,
  looksLikeAbsolutePath,
  unsupportedReason
} from '../modules/chat/file-support'

/** 上次使用的工作区（仅本机偏好，不参与安全校验——主进程会重新 resolve） */
const WORKSPACE_KEY = 'pet.task.workspace'
/** 左侧任务列表宽度（可拖动） */
const SIDEBAR_KEY = 'pet.task.sidebarWidth'
const SIDEBAR_DEFAULT = 216
const SIDEBAR_MIN = 140
const SIDEBAR_MAX = 360
/** 折叠后的窄条宽度 */
const SIDEBAR_COLLAPSED = 36

function agentBridge(): ReturnType<typeof getPetBridge>['agent'] | undefined {
  try {
    return getPetBridge().agent
  } catch {
    return undefined
  }
}

const STATUS_TEXT: Record<AgentState['status'], string> = {
  idle: '待命',
  preparing: '准备中',
  running: '执行中',
  waiting: '等你确认',
  done: '已完成',
  failed: '出错了',
  cancelled: '已中止'
}

function formatTime(ms: number): string {
  const date = new Date(ms)
  if (Number.isNaN(date.getTime())) return ''
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function formatDuration(startedAt?: number, endedAt?: number, now = Date.now()): string {
  if (!startedAt) return ''
  const seconds = Math.max(0, Math.round(((endedAt ?? now) - startedAt) / 1000))
  const mm = Math.floor(seconds / 60)
  const ss = seconds % 60
  return `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`
}

function formatTokens(value: number): string {
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`
  return String(value)
}

function copyText(text: string): void {
  if (!text) return
  try {
    getPetBridge().system.copyText(text)
  } catch {
    /* 旧 preload：静默降级 */
  }
}

function openExternal(href: string): void {
  try {
    void getPetBridge().system.openExternal(href)
  } catch {
    /* 旧 preload：静默降级 */
  }
}

function handleMarkdownClick(event: ReactMouseEvent<HTMLDivElement>): void {
  const anchor = (event.target as HTMLElement).closest('a')
  const href = anchor?.getAttribute('href') ?? ''
  if (href.startsWith('http://') || href.startsWith('https://')) {
    event.preventDefault()
    openExternal(href)
  }
}

/** 任务列表按时间分组：今天 / 昨天 / 7 天内 / 更早 */
function groupTasks(tasks: AgentTaskSummary[]): Array<{ label: string; items: AgentTaskSummary[] }> {
  const now = new Date()
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const startOfYesterday = startOfToday - 86_400_000
  const week = startOfToday - 6 * 86_400_000
  const buckets: Array<{ label: string; items: AgentTaskSummary[] }> = [
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

/** 消息底部：时间 · token · 复制（与对话模式一致，时间常显、按钮悬浮浮现） */
function MessageMeta({
  at,
  outputTokens,
  copied,
  onCopy
}: {
  at: number
  outputTokens?: number
  copied: boolean
  onCopy: () => void
}): ReactElement {
  return (
    <div className="work-meta task-meta">
      <span className="work-time">{formatTime(at)}</span>
      {outputTokens !== undefined ? (
        <span className="task-meta-tokens">
          输出 {outputTokens < 0 ? '—' : formatTokens(outputTokens)} tokens
        </span>
      ) : null}
      <span className="work-actions">
        <button type="button" className="work-action" title="复制" onClick={onCopy}>
          {copied ? '已复制' : '复制'}
        </button>
      </span>
    </div>
  )
}

/** 思考过程：运行中默认展开并显示“正在思考…”，结束后默认收起 */
function ThinkingBlock({
  step,
  open,
  onToggle,
  now
}: {
  step: AgentStep
  open: boolean
  onToggle: () => void
  now: number
}): ReactElement {
  const running = step.status === 'running'
  const seconds = Math.max(0, Math.round((now - step.startedAt) / 1000))
  // 思考内容持续增长：块内自动跟随到底（用户手动上翻时暂停）
  const bodyRef = useRef<HTMLPreElement | null>(null)
  const stickRef = useRef(true)
  useLayoutEffect(() => {
    const el = bodyRef.current
    if (!el || !stickRef.current) return
    el.scrollTop = el.scrollHeight
  }, [step.detail, open])
  return (
    <div className={`task-think${open ? ' task-think-open' : ''}`}>
      <button type="button" className="task-think-head" onClick={onToggle}>
        <span className="task-think-arrow" aria-hidden="true">
          {open ? '▾' : '▸'}
        </span>
        <span>思考过程</span>
        {running ? <span className="task-think-live">正在思考… {seconds}s</span> : null}
        {!running && step.detail ? (
          <span className="task-think-meta">{step.detail.length} 字</span>
        ) : null}
      </button>
      {open ? (
        <pre
          className="task-think-body"
          ref={bodyRef}
          onScroll={(event) => {
            const el = event.currentTarget
            stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
          }}
        >
          {step.detail || (running ? '正在思考…' : '（这次没有输出思考内容）')}
        </pre>
      ) : null}
      {running && open ? (
        <div className="task-streaming">
          <span className="task-spinner" aria-hidden="true" />
          <span>正在输出…</span>
        </div>
      ) : null}
    </div>
  )
}

/** 工具调用：流程里的细行，点开看命令与结果 */
function ToolRow({
  step,
  open,
  onToggle,
  onCommandMenu,
  now
}: {
  step: AgentStep
  open: boolean
  onToggle: () => void
  onCommandMenu: (command: string, x: number, y: number) => void
  now: number
}): ReactElement {
  const running = step.status === 'running'
  const seconds = Math.max(0, ((step.endedAt ?? now) - step.startedAt) / 1000)
  const icon = running ? '▸' : step.status === 'failed' ? '✗' : '✓'
  return (
    <div className={`task-tool task-tool-${step.status}`}>
      <button
        type="button"
        className="task-tool-head"
        onClick={onToggle}
        title={step.command ?? step.detail ?? ''}
        onContextMenu={(event) => {
          if (!step.command) return
          event.preventDefault()
          event.stopPropagation()
          onCommandMenu(step.command, event.clientX, event.clientY)
        }}
      >
        <span className="task-tool-icon" aria-hidden="true">
          {icon}
        </span>
        <span className="task-tool-title">{step.title}</span>
        {step.command ? <span className="task-tool-cmd">{step.command}</span> : null}
        <span className="task-tool-meta">
          {running ? `运行 ${Math.round(seconds)}s` : `${seconds.toFixed(1)}s`}
          {step.tokens ? ` · ${formatTokens(step.tokens.input)}/${formatTokens(step.tokens.output)}` : ''}
        </span>
      </button>
      {open && step.detail ? <pre className="task-tool-detail">{step.detail}</pre> : null}
    </div>
  )
}

function TodoList({ items }: { items: AgentTodoItem[] }): ReactElement {
  const done = items.filter((item) => item.status === 'done').length
  const pct = items.length > 0 ? Math.round((done / items.length) * 100) : 0
  return (
    <div className="task-card">
      <div className="task-card-head">
        <span className="task-card-title">待办</span>
        <span className="task-card-meta">
          {done}/{items.length}
        </span>
      </div>
      <div
        className="task-progress"
        role="progressbar"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <span className="task-progress-fill" style={{ width: `${pct}%` }} />
      </div>
      <ul className="task-todos">
        {items.map((item) => (
          <li key={item.id} className={`task-todo task-todo-${item.status}`}>
            <span className="task-todo-mark">
              {item.status === 'done' ? '✓' : item.status === 'active' ? '▸' : ''}
            </span>
            <span className="task-todo-text">{item.text}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

function attachmentKind(name: string): AgentAttachment['kind'] {
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase()
  if (['png', 'jpg', 'jpeg', 'webp', 'gif'].includes(ext)) return 'image'
  if (
    ['txt', 'md', 'json', 'yaml', 'yml', 'toml', 'csv', 'log', 'ts', 'tsx', 'js', 'jsx', 'py',
      'java', 'go', 'rs', 'c', 'h', 'cpp', 'hpp', 'css', 'html', 'sh', 'ps1', 'bat', 'sql'].includes(ext)
  ) {
    return 'text'
  }
  return 'other'
}

function fileGlyph(name: string): string {
  const kind = attachmentKind(name)
  return kind === 'image' ? '🖼' : kind === 'text' ? '📄' : '📎'
}

/** 附件条：图片显示缩略图 + 下方文件名，其它显示文件图标 + 文件名 */
function AttachmentStrip({
  files,
  previews,
  onRemove
}: {
  files: PickedFile[]
  previews: Record<string, string>
  onRemove: (path: string) => void
}): ReactElement | null {
  if (files.length === 0) return null
  return (
    <div className="task-attach-strip">
      {files.map((file) => (
        <div className="task-attach" key={file.path} title={file.path}>
          {previews[file.path] ? (
            <img className="task-attach-img" src={previews[file.path]} alt={file.name} />
          ) : (
            <span className="task-attach-icon" aria-hidden="true">
              {fileGlyph(file.name)}
            </span>
          )}
          <span className="task-attach-name">{file.name}</span>
          <button
            type="button"
            className="task-attach-remove"
            aria-label={`移除 ${file.name}`}
            onClick={() => onRemove(file.path)}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  )
}

function SendIcon(): ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M22 2 11 13" />
      <path d="M22 2 15 22l-4-9-9-4 20-7Z" />
    </svg>
  )
}

function StopIcon(): ReactElement {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <rect x="6" y="6" width="12" height="12" rx="2.5" />
    </svg>
  )
}

export default function TaskPanel(): ReactElement {
  const [state, setState] = useState<AgentState | null>(null)
  const [tasks, setTasks] = useState<AgentTaskSummary[]>([])
  const [workspace, setWorkspace] = useState<string>(() => {
    try {
      return localStorage.getItem(WORKSPACE_KEY) ?? ''
    } catch {
      return ''
    }
  })
  const [task, setTask] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [compose, setCompose] = useState(true)
  const [reply, setReply] = useState('')
  const [now, setNow] = useState(() => Date.now())
  const [showJump, setShowJump] = useState(false)
  const [copiedId, setCopiedId] = useState<string | null>(null)
  /** 本轮附件（不复制，主进程按原路径读取） */
  const [attachments, setAttachments] = useState<PickedFile[]>([])
  const [previews, setPreviews] = useState<Record<string, string>>({})
  const [fileNotice, setFileNotice] = useState<string | null>(null)
  /** 左侧列表宽度与折叠态 */
  const [sidebarWidth, setSidebarWidth] = useState<number>(() => {
    try {
      const raw = Number(localStorage.getItem(SIDEBAR_KEY))
      return Number.isFinite(raw) && raw >= SIDEBAR_MIN && raw <= SIDEBAR_MAX ? raw : SIDEBAR_DEFAULT
    } catch {
      return SIDEBAR_DEFAULT
    }
  })
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const sidebarDragRef = useRef<{ startX: number; startWidth: number; width: number } | null>(null)
  /** 悬浮预览卡片（网页链接 / 图片链接 / 本地路径） */
  const [hoverCard, setHoverCard] = useState<
    | { kind: 'link'; href: string; isImage: boolean; x: number; y: number }
    | { kind: 'path'; text: string; x: number; y: number }
    | null
  >(null)
  /** 右键菜单（任务 = 删除；选中文字 = 复制） */
  const [menu, setMenu] = useState<
    | { kind: 'task'; taskId: string; x: number; y: number }
    | { kind: 'text'; text: string; x: number; y: number }
    | { kind: 'command'; text: string; x: number; y: number }
    | null
  >(null)
  /** 思考块/工具行的展开覆盖（未设置时：思考运行中=展开、结束后收起；工具默认收起） */
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const stickRef = useRef(true)

  useEffect(() => {
    const api = agentBridge()
    if (!api) return
    let alive = true
    void api.getState().then((snapshot) => {
      if (!alive) return
      setState(snapshot)
      if (snapshot.status !== 'idle') setCompose(false)
    })
    void api.getTasks().then((list) => {
      if (alive) setTasks(list)
    })
    const offState = api.onState((snapshot) => {
      setState(snapshot)
      if (snapshot.status !== 'idle') setCompose(false)
    })
    const offTasks = api.onTasks((list) => setTasks(list))
    return () => {
      alive = false
      offState()
      offTasks()
    }
  }, [])

  const ticking = Boolean(
    state &&
      (state.status === 'running' || state.status === 'waiting' || state.status === 'preparing')
  )
  useEffect(() => {
    if (!ticking) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [ticking])

  useLayoutEffect(() => {
    if (!stickRef.current) return
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [state])

  const toAgentAttachments = useCallback(
    (): AgentAttachment[] =>
      attachments.map((file) => ({
        path: file.path,
        name: file.name,
        kind: attachmentKind(file.name)
      })),
    [attachments]
  )

  const addFiles = useCallback((files: PickedFile[]): void => {
    if (files.length === 0) return
    const rejected = files.filter((file) => unsupportedReason(file) !== null)
    if (rejected.length > 0) {
      setFileNotice(`「${rejected[0].name}」这个类型暂时看不了`)
      window.setTimeout(() => setFileNotice(null), 3000)
    }
    const usable = files.filter((file) => unsupportedReason(file) === null)
    if (usable.length === 0) return
    setAttachments((current) => {
      const merged = [...current]
      for (const file of usable) {
        if (merged.some((item) => item.path === file.path)) continue
        if (merged.length >= MAX_ATTACHMENTS) {
          setFileNotice(`一次最多带 ${MAX_ATTACHMENTS} 个文件`)
          window.setTimeout(() => setFileNotice(null), 3000)
          break
        }
        merged.push(file)
      }
      return merged
    })
    for (const file of usable) {
      if (attachmentKind(file.name) !== 'image') continue
      void agentBridge()
        ?.previewImage(file.path)
        .then((dataUrl) => {
          if (!dataUrl) return
          setPreviews((current) => ({ ...current, [file.path]: dataUrl }))
        })
    }
  }, [])

  const pickFiles = useCallback(async (): Promise<void> => {
    const bridge = filesBridge()
    if (!bridge?.pick) {
      setFileNotice('文件选择不可用：请重启应用')
      return
    }
    const picked = await bridge.pick()
    addFiles(picked)
  }, [addFiles])

  const removeAttachment = useCallback((path: string): void => {
    setAttachments((current) => current.filter((item) => item.path !== path))
    setPreviews((current) => {
      const next = { ...current }
      delete next[path]
      return next
    })
  }, [])

  const clearAttachments = useCallback((): void => {
    setAttachments([])
    setPreviews({})
  }, [])

  const handleDropFiles = useCallback(
    (event: React.DragEvent<HTMLDivElement>): void => {
      event.preventDefault()
      const bridge = filesBridge()
      if (!bridge?.pathFor || !bridge.stat) return
      const paths = Array.from(event.dataTransfer.files)
        .map((file) => bridge.pathFor?.(file) ?? '')
        .filter((item) => item.length > 0)
      if (paths.length === 0) return
      void Promise.all(paths.map((item) => bridge.stat?.(item))).then((files) => {
        addFiles(files.filter((file): file is PickedFile => Boolean(file)))
      })
    },
    [addFiles]
  )

  const handlePasteFiles = useCallback(
    (text: string): boolean => {
      if (!looksLikeAbsolutePath(text)) return false
      const bridge = filesBridge()
      if (!bridge?.stat) return false
      void bridge.stat(text.trim()).then((file) => {
        if (file) addFiles([file])
      })
      return true
    },
    [addFiles]
  )

  const saveSidebarWidth = useCallback((width: number): void => {
    try {
      localStorage.setItem(SIDEBAR_KEY, String(width))
    } catch {
      /* 隐私模式忽略 */
    }
  }, [])

  const onSidebarResizeStart = useCallback(
    (event: React.PointerEvent<HTMLDivElement>): void => {
      event.preventDefault()
      sidebarDragRef.current = {
        startX: event.clientX,
        startWidth: sidebarWidth,
        width: sidebarWidth
      }
      const move = (e: PointerEvent): void => {
        const drag = sidebarDragRef.current
        if (!drag) return
        const next = Math.min(SIDEBAR_MAX, Math.max(60, drag.startWidth + e.clientX - drag.startX))
        drag.width = next
        setSidebarWidth(next)
      }
      const up = (): void => {
        window.removeEventListener('pointermove', move)
        const drag = sidebarDragRef.current
        sidebarDragRef.current = null
        if (!drag) return
        if (drag.width < SIDEBAR_MIN) {
          // 拖到靠近最左边：吸附折叠
          setSidebarCollapsed(true)
          setSidebarWidth(SIDEBAR_DEFAULT)
          saveSidebarWidth(SIDEBAR_DEFAULT)
        } else {
          setSidebarCollapsed(false)
          setSidebarWidth(drag.width)
          saveSidebarWidth(drag.width)
        }
      }
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', up, { once: true })
    },
    [sidebarWidth, saveSidebarWidth]
  )

  const expandSidebar = useCallback((): void => {
    setSidebarCollapsed(false)
    setSidebarWidth(SIDEBAR_DEFAULT)
    saveSidebarWidth(SIDEBAR_DEFAULT)
  }, [saveSidebarWidth])

  const deleteTask = useCallback(async (id: string): Promise<void> => {
    const api = agentBridge()
    if (!api) return
    setMenu(null)
    const result = await api.deleteTask(id)
    if (!result.ok) {
      setError(result.error ?? '删除失败')
    }
  }, [])

  const markCopied = useCallback((id: string): void => {
    setCopiedId(id)
    window.setTimeout(() => setCopiedId((current) => (current === id ? null : current)), 1500)
  }, [])

  useEffect(() => {
    if (!menu) return
    const close = (): void => setMenu(null)
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setMenu(null)
    }
    window.addEventListener('pointerdown', close)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointerdown', close)
      window.removeEventListener('keydown', onKey)
    }
  }, [menu])

  const handleFlowHover = useCallback((event: React.MouseEvent<HTMLDivElement>): void => {
    const target = event.target as HTMLElement
    const link = target.closest('a')
    if (link) {
      const href = link.getAttribute('href') ?? ''
      if (href.startsWith('http://') || href.startsWith('https://')) {
        const rect = link.getBoundingClientRect()
        setHoverCard({
          kind: 'link',
          href,
          isImage: /\.(png|jpe?g|webp|gif)(\?|#|$)/i.test(href),
          x: rect.left,
          y: rect.top
        })
        return
      }
    }
    const code = target.closest('code')
    if (code) {
      const text = (code.textContent ?? '').trim()
      if (looksLikeAbsolutePath(text)) {
        const rect = code.getBoundingClientRect()
        setHoverCard({ kind: 'path', text, x: rect.left, y: rect.top })
        return
      }
    }
    setHoverCard(null)
  }, [])

  const handleFlowClick = useCallback((event: React.MouseEvent<HTMLDivElement>): void => {
    const target = event.target as HTMLElement
    if (target.closest('a')) return
    const code = target.closest('code')
    if (!code) return
    const text = (code.textContent ?? '').trim()
    if (!looksLikeAbsolutePath(text)) return
    event.preventDefault()
    try {
      void getPetBridge().system.openPath(text)
    } catch {
      /* 旧 preload：静默降级 */
    }
  }, [])

  const handleScroll = useCallback((): void => {
    const el = scrollRef.current
    if (!el) return
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 56
    stickRef.current = near
    setShowJump(!near)
  }, [])

  const jumpToBottom = useCallback((): void => {
    const el = scrollRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
    stickRef.current = true
    setShowJump(false)
  }, [])

  const toggleExpanded = useCallback((step: AgentStep): void => {
    setExpanded((current) => {
      const fallback = step.kind === 'thinking' && step.status === 'running'
      const wasOpen = current[step.id] ?? fallback
      return { ...current, [step.id]: !wasOpen }
    })
  }, [])

  const start = useCallback(async (): Promise<void> => {
    const api = agentBridge()
    if (!api) {
      setError('任务模式不可用：请重启应用')
      return
    }
    const trimmed = task.trim()
    if (!trimmed) {
      setError('先说说要做什么')
      return
    }
    if (!workspace) {
      setError('先选择一个工作区')
      return
    }
    setError(null)
    const result = await api.start({ task: trimmed, workspace, attachments: toAgentAttachments() })
    if (!result.ok) {
      setError(result.error ?? '启动失败')
      return
    }
    setTask('')
    clearAttachments()
    setCompose(false)
  }, [task, workspace, toAgentAttachments, clearAttachments])

  const send = useCallback(async (): Promise<void> => {
    const api = agentBridge()
    const text = reply.trim()
    if (!api || !text) return
    setError(null)
    const result = await api.followUp({ text, attachments: toAgentAttachments() })
    if (!result.ok) {
      setError(result.error ?? '发送失败')
      return
    }
    setReply('')
    clearAttachments()
  }, [reply, toAgentAttachments, clearAttachments])

  const pickWorkspace = useCallback(async (): Promise<void> => {
    const api = agentBridge()
    if (!api) return
    const picked = await api.pickWorkspace()
    if (!picked) return
    setWorkspace(picked)
    try {
      localStorage.setItem(WORKSPACE_KEY, picked)
    } catch {
      /* 隐私模式下写不进去，不影响本次使用 */
    }
  }, [])

  const selectTask = useCallback(async (id: string): Promise<void> => {
    const api = agentBridge()
    if (!api) return
    const result = await api.select(id)
    if (!result.ok) {
      setError(result.error ?? '切换失败')
      return
    }
    setError(null)
    setCompose(false)
    stickRef.current = true
  }, [])

  const approve = useCallback(
    (allow: boolean): void => {
      const approval = state?.approval
      if (!approval) return
      agentBridge()?.approve({ id: approval.id, allow })
    },
    [state?.approval]
  )

  const groups = useMemo(() => groupTasks(tasks), [tasks])
  const approval = state?.approval
  const remaining = approval ? Math.max(0, Math.ceil((approval.expiresAt - now) / 1000)) : 0
  const busy =
    state?.status === 'preparing' || state?.status === 'running' || state?.status === 'waiting'
  const duration = state?.startedAt ? formatDuration(state.startedAt, state.endedAt, now) : ''
  const showHero = compose || !state || state.status === 'idle'
  const flow = (state?.steps ?? []).filter((step) => step.kind !== 'todo').slice(-200)
  const usage = state?.usage

  return (
    <div className="task-layout">
      <aside
        className={`task-sidebar${sidebarCollapsed ? ' task-sidebar-collapsed' : ''}`}
        style={{ width: sidebarCollapsed ? SIDEBAR_COLLAPSED : sidebarWidth }}
      >
        {sidebarCollapsed ? (
          <button
            type="button"
            className="task-sidebar-expand"
            title="展开任务列表"
            aria-label="展开任务列表"
            onClick={expandSidebar}
          >
            ▸
          </button>
        ) : (
          <>
            <button
              type="button"
              className={`task-new${compose ? ' task-new-active' : ''}`}
              onClick={() => setCompose(true)}
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
                          !compose && state?.id === item.id ? ' task-item-active' : ''
                        }`}
                        title={`${item.task}\n${item.workspace}`}
                        onClick={() => void selectTask(item.id)}
                        onContextMenu={(event) => {
                          event.preventDefault()
                          event.stopPropagation()
                          setMenu({ kind: 'task', taskId: item.id, x: event.clientX, y: event.clientY })
                        }}
                      >
                        <span className={`task-item-dot task-item-dot-${item.status}`} />
                        <span className="task-item-text">{item.task}</span>
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
              onPointerDown={onSidebarResizeStart}
            />
          </>
        )}
      </aside>

      <div
        className="task-main"
        onContextMenu={(event) => {
          const selection = window.getSelection()?.toString() ?? ''
          if (selection.trim().length > 0) {
            event.preventDefault()
            setMenu({ kind: 'text', text: selection, x: event.clientX, y: event.clientY })
          }
        }}
      >
        {showHero ? (
          <div className="task-hero">
            <div className="task-hero-title">你好，要做什么？</div>
            <div className="task-hero-sub">写代码、分析文档、查系统、拆解任务都可以</div>
            <div
              className="task-hero-card"
              onDragOver={(event) => event.preventDefault()}
              onDrop={handleDropFiles}
            >
              <AttachmentStrip
                files={attachments}
                previews={previews}
                onRemove={removeAttachment}
              />
              <textarea
                className="task-hero-input"
                value={task}
                placeholder="比如：看一下系统盘哪些文件可以清理"
                rows={4}
                onChange={(event) => setTask(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                    event.preventDefault()
                    void start()
                  }
                }}
                onPaste={(event) => {
                  const text = event.clipboardData.getData('text')
                  if (handlePasteFiles(text)) event.preventDefault()
                }}
              />
              <div className="task-hero-foot">
                <div className="task-hero-tools">
                  <button
                    type="button"
                    className="task-attach-btn"
                    title="添加文件 / 图片"
                    aria-label="添加文件"
                    onClick={() => void pickFiles()}
                  >
                    +
                  </button>
                  <button type="button" className="task-ws-btn" onClick={() => void pickWorkspace()}>
                  <span className="task-ws-label">工作区</span>
                    <span className={`task-ws-value${workspace ? '' : ' task-ws-empty'}`}>
                      {workspace || '未选择'}
                    </span>
                  </button>
                </div>
                <button
                  type="button"
                  className="task-btn task-btn-primary"
                  onClick={() => void start()}
                >
                  开始
                </button>
              </div>
            </div>
            {error ? <div className="task-error">{error}</div> : null}
            <div className="task-hero-hint">
              写文件、执行命令前会先问你 · 只读操作直接放行 · Enter 开始，Shift+Enter 换行
            </div>
          </div>
        ) : (
          <>
            <header className="task-head task-head-slim">
              <div className="task-head-main">
                <span className={`task-status task-status-${state?.status ?? 'idle'}`}>
                  <i className="task-dot" aria-hidden="true" />
                  <span>{STATUS_TEXT[state?.status ?? 'idle']}</span>
                </span>
              </div>
              <div className="task-head-actions">
                {!busy ? (
                  <button type="button" className="task-btn" onClick={() => setCompose(true)}>
                    新任务
                  </button>
                ) : null}
              </div>
            </header>

            <div
              className="task-scroll pui-scroll"
              ref={scrollRef}
              onScroll={handleScroll}
              onMouseOver={handleFlowHover}
              onMouseLeave={() => setHoverCard(null)}
              onClick={handleFlowClick}
            >
              <div className="task-flow">
                {state?.task ? (
                  <div className="task-start-line" title={state.workspace}>
                    <span className="task-start-mark" aria-hidden="true">
                      ✦
                    </span>
                    <span>{state.task}</span>
                    <span className="task-start-ws">{state.workspace}</span>
                  </div>
                ) : null}

                {state && state.todos.length > 0 ? <TodoList items={state.todos} /> : null}

                {flow.map((step) => {
                  if (step.kind === 'round') {
                    return (
                      <div className="task-msg task-msg-user" key={step.id}>
                        <div className="task-bubble">{step.title}</div>
                        <MessageMeta
                          at={step.startedAt}
                          copied={copiedId === step.id}
                          onCopy={() => {
                            copyText(step.title)
                            markCopied(step.id)
                          }}
                        />
                      </div>
                    )
                  }
                  if (step.kind === 'thinking') {
                    return (
                      <ThinkingBlock
                        key={step.id}
                        step={step}
                        now={now}
                        open={expanded[step.id] ?? step.status === 'running'}
                        onToggle={() => toggleExpanded(step)}
                      />
                    )
                  }
                  if (step.kind === 'tool') {
                    return (
                      <ToolRow
                        key={step.id}
                        step={step}
                        now={now}
                        open={expanded[step.id] ?? false}
                        onToggle={() => toggleExpanded(step)}
                        onCommandMenu={(command, x, y) =>
                          setMenu({ kind: 'command', text: command, x, y })
                        }
                      />
                    )
                  }
                  if (step.kind === 'stats') {
                    const stats = step.stats
                    const seconds = Math.max(0, Math.round(((step.endedAt ?? step.startedAt) - step.startedAt) / 1000))
                    const mm = String(Math.floor(seconds / 60)).padStart(2, '0')
                    const ss = String(seconds % 60).padStart(2, '0')
                    return (
                      <div className="task-round-stats" key={step.id}>
                        本轮耗时 {mm}:{ss}
                        {stats ? (
                          <>
                            <span className="task-stats-sep"> · </span>
                            调用 {stats.calls} 次
                            <span className="task-stats-sep"> · </span>
                            输入 {formatTokens(stats.input)} / 输出 {formatTokens(stats.output)} tokens
                            {stats.cacheRead > 0 ? (
                              <>
                                <span className="task-stats-sep"> · </span>
                                缓存命中 {formatTokens(stats.cacheRead)}
                              </>
                            ) : null}
                            {stats.contextWindow && stats.contextUsed ? (
                              <>
                                <span className="task-stats-sep"> · </span>
                                <span
                                  className={`task-context${
                                    stats.contextUsed / stats.contextWindow >= 0.9
                                      ? ' task-context-danger'
                                      : stats.contextUsed / stats.contextWindow >= 0.8
                                        ? ' task-context-warn'
                                        : ''
                                  }`}
                                >
                                  上下文 {formatTokens(stats.contextUsed)} /{' '}
                                  {formatTokens(stats.contextWindow)}（
                                  {Math.round((stats.contextUsed / stats.contextWindow) * 100)}%）
                                </span>
                              </>
                            ) : null}
                          </>
                        ) : null}
                      </div>
                    )
                  }
                  if (step.kind === 'text') {
                    return (
                      <div className="task-msg task-msg-assistant" key={step.id}>
                        {step.detail ? (
                          <div
                            className="md-body work-markdown task-md"
                            onClick={handleMarkdownClick}
                            dangerouslySetInnerHTML={{
                              __html: renderMarkdownWithCitations(step.detail)
                            }}
                          />
                        ) : null}
                        {step.status === 'running' ? (
                          <div className="task-streaming">
                            <span className="task-spinner" aria-hidden="true" />
                            <span>生成中…</span>
                          </div>
                        ) : null}
                        <MessageMeta
                          at={step.startedAt}
                          outputTokens={
                            step.tokens
                              ? step.tokens.output
                              : step.status === 'running'
                                ? undefined
                                : -1
                          }
                          copied={copiedId === step.id}
                          onCopy={() => {
                            copyText(step.detail ?? '')
                            markCopied(step.id)
                          }}
                        />
                      </div>
                    )
                  }
                  return null
                })}

                {approval ? (
                  <div
                    className={`task-approval${approval.dangerous ? ' task-approval-danger' : ''}`}
                  >
                    <div className="task-approval-head">
                      <span className="task-approval-icon" aria-hidden="true">
                        {approval.dangerous ? '⚠' : '✦'}
                      </span>
                      <span>{approval.dangerous ? '危险操作，请确认' : '需要你确认'}</span>
                      <span className="task-approval-timer">{remaining}s</span>
                    </div>
                    <div className="task-approval-title">{approval.title}</div>
                    {approval.command ? (
                      <pre className="task-approval-cmd">{approval.command}</pre>
                    ) : null}
                    {approval.preview ? (
                      <pre className="task-approval-preview">{approval.preview}</pre>
                    ) : null}
                    <div className="task-approval-actions">
                      <button type="button" className="task-btn" onClick={() => approve(false)}>
                        拒绝
                      </button>
                      <button
                        type="button"
                        className="task-btn task-btn-primary"
                        onClick={() => approve(true)}
                      >
                        允许
                      </button>
                    </div>
                    <div className="task-approval-hint">不操作将自动拒绝</div>
                  </div>
                ) : null}

                {state?.summary ? (
                  <div className="task-msg task-msg-assistant">
                    <div
                      className="md-body work-markdown task-md"
                      onClick={handleMarkdownClick}
                      dangerouslySetInnerHTML={{
                        __html: renderMarkdownWithCitations(state.summary)
                      }}
                    />
                    <MessageMeta
                      at={state.endedAt ?? state.startedAt ?? Date.now()}
                      copied={copiedId === 'summary'}
                      onCopy={() => {
                        copyText(state.summary ?? '')
                        markCopied('summary')
                      }}
                    />
                  </div>
                ) : null}

                {state?.error ? <div className="task-error">{state.error}</div> : null}

              </div>
            </div>

            {showJump ? (
              <button type="button" className="task-jump" onClick={jumpToBottom}>
                ↓ 最新
              </button>
            ) : null}

            <div
              className="task-composer"
              onDragOver={(event) => event.preventDefault()}
              onDrop={handleDropFiles}
            >
              <AttachmentStrip
                files={attachments}
                previews={previews}
                onRemove={removeAttachment}
              />
              {error || fileNotice ? (
                <div className="task-notice">{error ?? fileNotice}</div>
              ) : null}
              <div className="work-input-shell">
                <Textarea
                  className="work-input"
                  value={reply}
                  autoGrow
                  maxRows={8}
                  rows={1}
                  disabled={!state?.resumable}
                  placeholder={
                    !state?.resumable
                      ? '这个任务的上下文已释放，点「新任务」重新开始'
                      : busy
                        ? '任务进行中，可以插话…（Enter 发送）'
                        : '接着说点什么…（Enter 发送，Shift+Enter 换行）'
                  }
                  aria-label="任务输入"
                  onValueChange={setReply}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                      event.preventDefault()
                      if (state?.resumable && reply.trim()) void send()
                    }
                  }}
                  onPaste={(event) => {
                    const text = event.clipboardData.getData('text')
                    if (handlePasteFiles(text)) event.preventDefault()
                  }}
                />
                <div className="work-input-actions">
                  <button
                    type="button"
                    className="task-attach-btn"
                    title="添加文件 / 图片"
                    aria-label="添加文件"
                    onClick={() => void pickFiles()}
                  >
                    +
                  </button>
                  {busy ? (
                    <button
                      type="button"
                      className="work-send work-send-stop"
                      title="中止任务"
                      aria-label="中止"
                      onClick={() => agentBridge()?.cancel()}
                    >
                      <StopIcon />
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="work-send"
                      title="发送（Enter）"
                      aria-label="发送"
                      disabled={!reply.trim() || !state?.resumable}
                      onClick={() => void send()}
                    >
                      <SendIcon />
                    </button>
                  )}
                </div>
              </div>
            </div>
          </>
        )}

        {hoverCard ? (
          <div
            className={`task-preview task-preview-${hoverCard.kind}`}
            style={{
              left: Math.max(8, Math.min(hoverCard.x, window.innerWidth - 340)),
              top: Math.max(8, hoverCard.y - 8)
            }}
          >
            {hoverCard.kind === 'link' ? (
              <>
                {hoverCard.isImage ? (
                  <img
                    className="task-preview-img"
                    src={hoverCard.href}
                    alt=""
                    onError={(event) => {
                      event.currentTarget.style.display = 'none'
                    }}
                  />
                ) : null}
                <div className="task-preview-url">{hoverCard.href}</div>
                <div className="task-preview-hint">点击在浏览器打开</div>
              </>
            ) : (
              <>
                <div className="task-preview-url">{hoverCard.text}</div>
                <div className="task-preview-hint">点击用默认程序打开</div>
              </>
            )}
          </div>
        ) : null}
      </div>

      {menu ? (
        <div
          className="task-menu"
          style={{ left: menu.x, top: menu.y }}
          onPointerDown={(event) => event.stopPropagation()}
        >
          {menu.kind === 'task' ? (
            <button type="button" className="task-menu-item" onClick={() => void deleteTask(menu.taskId)}>
              删除任务
            </button>
          ) : menu.kind === 'command' ? (
            <button
              type="button"
              className="task-menu-item"
              onClick={() => {
                copyText(menu.text)
                setMenu(null)
              }}
            >
              复制命令
            </button>
          ) : (
            <button
              type="button"
              className="task-menu-item"
              onClick={() => {
                copyText(menu.text)
                setMenu(null)
              }}
            >
              复制
            </button>
          )}
        </div>
      ) : null}
    </div>
  )
}
