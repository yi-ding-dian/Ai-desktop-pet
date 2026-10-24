/**
 * 工作窗「任务」标签页（2026-10-23）。
 *
 * 布局：左侧任务列表 + 右侧消息流（我右 / 模型左），底部输入条。
 * 数据：任务状态来自主进程 agent 域（多 Session），面板挂载时补拉，之后靠推送刷新。
 *
 * 展示细节拆在同目录：TaskList（左栏）/ AgentFlow（消息流）/ TaskHero（新任务）
 * / ComposerBar（输入条）/ HoverCard（悬浮预览）。
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactElement
} from 'react'
import type {
  AgentAttachment,
  AgentState,
  AgentStep,
  AgentTaskSummary,
  ExecutionMode,
  PickedFile
} from '../../../electron/ipc/channels'
import { getPetBridge } from '../../shared/pet-bridge'
import {
  MAX_ATTACHMENTS,
  filesBridge,
  looksLikeAbsolutePath,
  unsupportedReason
} from '../../modules/chat/file-support'
import { copyText } from '../format'
import { attachmentKind } from '../message/AttachmentStrip'
import LinkPreviewCard from '../conversation/LinkPreviewCard'
import { useLinkHover } from '../conversation/useLinkHover'
import AgentFlow from './AgentFlow'
import ComposerBar from './ComposerBar'
import HoverCard, { type HoverCardState } from './HoverCard'
import TaskHero from './TaskHero'
import TaskList, { groupTasks } from './TaskList'
import TaskModeSelector from './TaskModeSelector'

/** 上次使用的工作区（仅本机偏好，不参与安全校验——主进程会重新 resolve） */
const WORKSPACE_KEY = 'pet.task.workspace'
/** 左侧任务列表宽度（可拖动） */
const SIDEBAR_KEY = 'pet.task.sidebarWidth'
const SIDEBAR_DEFAULT = 216
const SIDEBAR_MIN = 140
const SIDEBAR_MAX = 360

function agentBridge(): ReturnType<typeof getPetBridge>['agent'] | undefined {
  try {
    return getPetBridge().agent
  } catch {
    return undefined
  }
}

const STATUS_TEXT: Record<AgentState['status'], string> = {
  idle: '待命',
  queued: '排队中',
  preparing: '准备中',
  running: '执行中',
  waiting: '等你确认',
  planned: '待执行',
  done: '已完成',
  failed: '出错了',
  cancelled: '已中止'
}

const MODE_KEY = 'pet.task.mode'

export interface TaskPanelProps {
  /** 通知点击后要切到的任务 id */
  focusTaskId?: string | null
  onFocusHandled?: () => void
}

export default function TaskPanel({
  focusTaskId = null,
  onFocusHandled
}: TaskPanelProps = {}): ReactElement {
  const [state, setState] = useState<AgentState | null>(null)
  /** 新任务页选中的执行模式（记住上次选择） */
  const [composeMode, setComposeMode] = useState<ExecutionMode>(() => {
    try {
      const saved = localStorage.getItem(MODE_KEY)
      return saved === 'auto' || saved === 'plan' || saved === 'standard' ? saved : 'standard'
    } catch {
      return 'standard'
    }
  })
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
  /** 悬浮预览卡片（本地路径；网页链接走 useLinkHover，与对话模式一致） */
  const [hoverCard, setHoverCard] = useState<HoverCardState | null>(null)
  /** 引用/来源链接卡片：来源来自联网工具（AgentState.sources） */
  const linkHover = useLinkHover(state?.sources, state?.summary)
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

  // 面板可见性上报：面板挂载 ≠ 用户在看（切到别的标签页/工作窗被隐藏）
  useEffect(() => {
    const api = agentBridge()
    if (!api?.panelActive) return
    const sync = (): void => api.panelActive(document.visibilityState === 'visible')
    sync()
    document.addEventListener('visibilitychange', sync)
    return () => {
      document.removeEventListener('visibilitychange', sync)
      api.panelActive(false)
    }
  }, [])

  const ticking = Boolean(
    state &&
      (state.status === 'running' ||
        state.status === 'waiting' ||
        state.status === 'preparing' ||
        state.status === 'queued')
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
    (event: ReactDragEvent<HTMLDivElement>): void => {
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
    (event: ReactPointerEvent<HTMLDivElement>): void => {
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

  const handleCopyStep = useCallback(
    (id: string, text: string): void => {
      copyText(text)
      markCopied(id)
    },
    [markCopied]
  )

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

  const handleFlowHover = useCallback((event: ReactMouseEvent<HTMLDivElement>): void => {
    const target = event.target as HTMLElement
    const link = target.closest('a')
    if (link) {
      const href = link.getAttribute('href') ?? ''
      if (href.startsWith('http://') || href.startsWith('https://')) {
        // 与对话模式同一套卡片（站点/日期/标题/摘要）
        linkHover.onMouseOver(event)
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
  }, [linkHover])

  /** 离开链接时收起卡片（与对话模式同一套判定：指针是否仍在同一个 a 内） */
  const handleFlowOut = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>): void => {
      linkHover.onMouseOut(event)
    },
    [linkHover]
  )

  const handleFlowClick = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>): void => {
      linkHover.clear()
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
    },
    [linkHover]
  )

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
    const result = await api.start({
      task: trimmed,
      workspace,
      attachments: toAgentAttachments(),
      mode: composeMode
    })
    if (!result.ok) {
      setError(result.error ?? '启动失败')
      return
    }
    setTask('')
    clearAttachments()
    setCompose(false)
  }, [task, workspace, composeMode, toAgentAttachments, clearAttachments])

  const chooseComposeMode = useCallback((mode: ExecutionMode): void => {
    setComposeMode(mode)
    try {
      localStorage.setItem(MODE_KEY, mode)
    } catch {
      /* 隐私模式下写不进去，不影响本次使用 */
    }
  }, [])

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

  const changeMode = useCallback(
    async (mode: ExecutionMode): Promise<void> => {
      const api = agentBridge()
      const id = state?.id
      if (!api || !id) return
      const result = await api.setMode({ id, mode })
      if (!result.ok) setError(result.error ?? '切换模式失败')
    },
    [state?.id]
  )

  const answerQuestion = useCallback(async (id: string, answer: string): Promise<void> => {
    const api = agentBridge()
    if (!api) return
    const result = await api.answerQuestion({ id, answer })
    if (!result.ok) setError(result.error ?? '提交失败')
  }, [])

  const executePlan = useCallback(
    async (mode: 'standard' | 'auto'): Promise<void> => {
      const api = agentBridge()
      const id = state?.id
      if (!api || !id) return
      setError(null)
      const result = await api.executePlan({ id, mode })
      if (!result.ok) setError(result.error ?? '执行失败')
    },
    [state?.id]
  )

  // 通知点击：切到指定任务
  useEffect(() => {
    if (!focusTaskId) return
    void selectTask(focusTaskId).then(() => onFocusHandled?.())
  }, [focusTaskId, onFocusHandled, selectTask])

  const groups = useMemo(() => groupTasks(tasks), [tasks])
  const approval = state?.approval
  const remaining = approval ? Math.max(0, Math.ceil((approval.expiresAt - now) / 1000)) : 0
  const busy =
    state?.status === 'queued' ||
    state?.status === 'preparing' ||
    state?.status === 'running' ||
    state?.status === 'waiting'
  const showHero = compose || !state || state.status === 'idle'
  const flow = (state?.steps ?? []).filter((step) => step.kind !== 'todo').slice(-200)

  return (
    <div className="task-layout">
      <TaskList
        groups={groups}
        collapsed={sidebarCollapsed}
        width={sidebarWidth}
        compose={compose}
        activeId={state?.id}
        onNew={() => setCompose(true)}
        onExpand={expandSidebar}
        onSelect={(id) => void selectTask(id)}
        onContextMenu={(taskId, x, y) => setMenu({ kind: 'task', taskId, x, y })}
        onResizeStart={onSidebarResizeStart}
      />

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
          <TaskHero
            task={task}
            workspace={workspace}
            mode={composeMode}
            onModeChange={chooseComposeMode}
            attachments={attachments}
            previews={previews}
            error={error}
            onTaskChange={setTask}
            onDrop={handleDropFiles}
            onRemoveAttachment={removeAttachment}
            onPaste={handlePasteFiles}
            onPickFiles={() => void pickFiles()}
            onPickWorkspace={() => void pickWorkspace()}
            onStart={() => void start()}
          />
        ) : (
          <>
            <header className="task-head task-head-slim">
              <div className="task-head-main">
                <span className={`task-status task-status-${state?.status ?? 'idle'}`}>
                  <i className="task-dot" aria-hidden="true" />
                  <span>
                    {state?.status === 'waiting' && state.question
                      ? '等你回答'
                      : STATUS_TEXT[state?.status ?? 'idle']}
                  </span>
                </span>
                {state && state.id && state.status !== 'idle' ? (
                  <TaskModeSelector mode={state.mode} onChange={(mode) => void changeMode(mode)} compact />
                ) : null}
              </div>
              <div className="task-head-actions">
                <button type="button" className="task-btn" onClick={() => setCompose(true)}>
                  新任务
                </button>
              </div>
            </header>

            <div
              className="task-scroll pui-scroll"
              ref={scrollRef}
              onScroll={handleScroll}
              onMouseOver={handleFlowHover}
              onMouseOut={handleFlowOut}
              onMouseLeave={() => setHoverCard(null)}
              onClick={handleFlowClick}
            >
              <AgentFlow
                task={state?.task}
                workspace={state?.workspace}
                flow={flow}
                todos={state?.todos ?? []}
                now={now}
                expanded={expanded}
                copiedId={copiedId}
                summary={state?.summary}
                startedAt={state?.startedAt}
                endedAt={state?.endedAt}
                error={state?.error}
                approval={approval}
                remaining={remaining}
                question={state?.question}
                status={state?.status}
                mode={state?.mode}
                canExecutePlan={Boolean(state?.resumable)}
                onAnswer={(id, answer) => void answerQuestion(id, answer)}
                onExecutePlan={(mode) => void executePlan(mode)}
                onToggle={toggleExpanded}
                onCopy={handleCopyStep}
                onCommandMenu={(command, x, y) =>
                  setMenu({ kind: 'command', text: command, x, y })
                }
                onApprove={approve}
              />
            </div>

            {showJump ? (
              <button type="button" className="task-jump" onClick={jumpToBottom}>
                ↓ 最新
              </button>
            ) : null}

            <ComposerBar
              value={reply}
              busy={busy}
              resumable={state?.resumable}
              status={state?.status}
              attachments={attachments}
              previews={previews}
              notice={fileNotice}
              error={error}
              onValueChange={setReply}
              onDrop={handleDropFiles}
              onRemoveAttachment={removeAttachment}
              onPaste={handlePasteFiles}
              onPickFiles={() => void pickFiles()}
              onSend={() => void send()}
              onStop={() => {
                const id = state?.id
                if (id) void agentBridge()?.cancel(id)
              }}
            />
          </>
        )}

        <HoverCard card={hoverCard} />
        {linkHover.preview !== null ? (
          <LinkPreviewCard
            key={linkHover.preview.url}
            preview={linkHover.preview}
            onMeasure={linkHover.onMeasure}
          />
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
