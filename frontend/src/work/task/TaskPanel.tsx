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
  AgentLlmStatus,
  AgentState,
  AgentStep,
  AgentTaskDraftPayload,
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
import { copyText, formatCost, formatMoney, formatWorkspacePath } from '../format'
import { attachmentKind } from '../message/AttachmentStrip'
import LinkPreviewCard from '../conversation/LinkPreviewCard'
import { useLinkHover } from '../conversation/useLinkHover'
import AgentFlow from './AgentFlow'
import ComposerBar from './ComposerBar'
import HoverCard, { type HoverCardState } from './HoverCard'
import { buildTaskHistory } from './history'
import type { ComposerHistoryItem } from '../message/history'
import TaskHero from './TaskHero'
import TaskList, { groupTasks } from './TaskList'
import TaskModeSelector from './TaskModeSelector'

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

const THINKING_MENU_LABELS: Record<string, string> = {
  low: 'low · 省 token',
  high: 'high · 默认',
  max: 'max · 复杂任务'
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
  /** 正文链接点击（与对话模式一致：内嵌浏览器打开） */
  onLinkClick?: (event: ReactMouseEvent<HTMLDivElement>) => void
  /** 宠物窗带文件的消息转来的草稿：预填并自动开始 */
  draft?: AgentTaskDraftPayload | null
  onDraftHandled?: (id: string) => void
}

/** 去掉 IPC 包装后的可读错误（invoke reject 会带 "Error invoking remote method ..." 前缀） */
function errorText(err: unknown): string {
  const raw = (err as Error)?.message ?? String(err)
  return raw.replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '')
}

export default function TaskPanel({
  focusTaskId = null,
  onFocusHandled,
  onLinkClick,
  draft = null,
  onDraftHandled
}: TaskPanelProps = {}): ReactElement {
  const [state, setState] = useState<AgentState | null>(null)
  /** 顶部：当前模型 + 账户余额（主进程 10 分钟轮询） */
  const [llmStatus, setLlmStatus] = useState<AgentLlmStatus | null>(null)
  const [refreshingLlm, setRefreshingLlm] = useState(false)
  /** 思考强度菜单 / 保存中 / 「下次生效」提示 */
  const [thinkingOpen, setThinkingOpen] = useState(false)
  const [savingThinking, setSavingThinking] = useState(false)
  const [thinkingNotice, setThinkingNotice] = useState<{
    text: string
    error: boolean
  } | null>(null)
  const thinkingRef = useRef<HTMLDivElement | null>(null)
  const thinkingNoticeTimer = useRef<number | null>(null)
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
  /** 默认工作区（config.toml [agent]；空 = 平台默认）；不再恢复"上次工作区" */
  const [workspace, setWorkspace] = useState('')
  /** 手输/选择后的工作区校验状态（开始与设为默认都要求 valid） */
  const [workspaceCheck, setWorkspaceCheck] = useState<{
    status: 'checking' | 'valid' | 'invalid'
    error: string | null
  }>({ status: 'checking', error: null })
  const wsTimerRef = useRef<number | null>(null)
  /** 校验请求序号：输入变化后旧请求的结果直接丢弃 */
  const wsSeqRef = useRef(0)
  const [wsNotice, setWsNotice] = useState<string | null>(null)
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
  /** 已处理过的草稿 id（防止重渲染/重复事件把同一份文件启动两次） */
  const handledDraftRef = useRef<string | null>(null)
  /** 处理过草稿后保持 true：压住 getState/状态推送的「切到已有任务」，避免把草稿页藏掉 */
  const draftActiveRef = useRef(false)
  /** 历史定位后的短暂高亮锚点与定时器 */
  const [flashId, setFlashId] = useState<string | null>(null)
  const flashTimerRef = useRef<number | null>(null)

  useEffect(() => {
    const api = agentBridge()
    if (!api) return
    let alive = true
    void api.getState().then((snapshot) => {
      if (!alive) return
      setState(snapshot)
      if (snapshot.status !== 'idle' && !draftActiveRef.current) setCompose(false)
    })
    void api.getTasks().then((list) => {
      if (alive) setTasks(list)
    })
    void api
      .getLlmStatus()
      .then((status) => {
        if (alive) setLlmStatus(status)
      })
      .catch(() => {
        /* 余额是软功能：拿不到就不显示 */
      })
    const offState = api.onState((snapshot) => {
      setState(snapshot)
      if (snapshot.status !== 'idle' && !draftActiveRef.current) setCompose(false)
    })
    const offTasks = api.onTasks((list) => setTasks(list))
    const offLlm = api.onLlmStatus((status) => setLlmStatus(status))
    return () => {
      alive = false
      offState()
      offTasks()
      offLlm()
    }
  }, [])

  // 默认工作区：新任务每次从这里开始；配置无效 → 行内提示，不静默换目录
  useEffect(() => {
    const api = agentBridge()
    if (!api?.getDefaultWorkspace) {
      setWorkspaceCheck({ status: 'invalid', error: '任务模式不可用：请重启应用' })
      return
    }
    let alive = true
    void api
      .getDefaultWorkspace()
      .then((path) => {
        if (!alive) return
        setWorkspace(path)
        // 主进程解析默认工作区时已经做过存在性/目录校验
        setWorkspaceCheck({ status: 'valid', error: null })
      })
      .catch((err) => {
        if (!alive) return
        setWorkspaceCheck({ status: 'invalid', error: errorText(err) })
      })
    return () => {
      alive = false
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

  // 切任务/卸载：清掉高亮定时器
  useEffect(() => {
    return () => {
      if (flashTimerRef.current !== null) window.clearTimeout(flashTimerRef.current)
    }
  }, [])
  // 切换任务：清掉上一条历史选中文本、附件和定位高亮
  useEffect(() => {
    setFlashId(null)
    setReply('')
    clearAttachments()
    setFileNotice(null)
    if (flashTimerRef.current !== null) {
      window.clearTimeout(flashTimerRef.current)
      flashTimerRef.current = null
    }
  }, [state?.id, clearAttachments])

  /** 历史条目的时间点击：滚到消息流里的原文并短暂高亮；同时暂停自动跟到底 */
  const locateHistoryItem = useCallback((item: ComposerHistoryItem): void => {
    const scroller = scrollRef.current
    if (!scroller) return
    const target = scroller.querySelector<HTMLElement>(
      `[data-step-id="${CSS.escape(item.id)}"]`
    )
    if (!target) {
      setFileNotice('这条消息太久了，已不在当前视图里')
      window.setTimeout(() => setFileNotice(null), 3_000)
      return
    }
    setFileNotice(null)
    stickRef.current = false
    setShowJump(true)
    target.scrollIntoView({ block: 'center', behavior: 'smooth' })
    setFlashId(item.id)
    if (flashTimerRef.current !== null) window.clearTimeout(flashTimerRef.current)
    flashTimerRef.current = window.setTimeout(() => {
      setFlashId(null)
      flashTimerRef.current = null
    }, 1_300)
  }, [])

  const toggleExpanded = useCallback((step: AgentStep): void => {
    setExpanded((current) => {
      const fallback = step.kind === 'thinking' && step.status === 'running'
      const wasOpen = current[step.id] ?? fallback
      return { ...current, [step.id]: !wasOpen }
    })
  }, [])

  const clearWsTimer = useCallback((): void => {
    if (wsTimerRef.current === null) return
    window.clearTimeout(wsTimerRef.current)
    wsTimerRef.current = null
  }, [])

  useEffect(() => () => clearWsTimer(), [clearWsTimer])

  /** 校验工作区（与主进程 agentService.start 同一套规则）；返回是否可用 */
  const checkWorkspace = useCallback(async (raw: string): Promise<boolean> => {
    const api = agentBridge()
    const text = raw.trim()
    if (!api) {
      setWorkspaceCheck({ status: 'invalid', error: '任务模式不可用：请重启应用' })
      return false
    }
    if (!text) {
      wsSeqRef.current += 1
      setWorkspaceCheck({ status: 'invalid', error: '工作区不能为空' })
      return false
    }
    const seq = wsSeqRef.current + 1
    wsSeqRef.current = seq
    setWorkspaceCheck({ status: 'checking', error: null })
    try {
      const result = await api.validateWorkspace(text)
      if (wsSeqRef.current !== seq) return false
      if (result.ok) {
        setWorkspaceCheck({ status: 'valid', error: null })
        return true
      }
      setWorkspaceCheck({ status: 'invalid', error: result.error ?? '工作区不可用' })
      return false
    } catch (err) {
      if (wsSeqRef.current !== seq) return false
      setWorkspaceCheck({ status: 'invalid', error: errorText(err) })
      return false
    }
  }, [])

  /** 输入路径：去资源管理器「复制为路径」带的首尾引号，400ms 防抖校验 */
  const handleWorkspaceChange = useCallback(
    (value: string): void => {
      const trimmed = value.trim()
      const next =
        trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')
          ? trimmed.slice(1, -1)
          : value
      setWorkspace(next)
      setError(null)
      clearWsTimer()
      wsSeqRef.current += 1 // 让在途的旧校验结果失效
      if (!next.trim()) {
        setWorkspaceCheck({ status: 'invalid', error: '工作区不能为空' })
        return
      }
      setWorkspaceCheck({ status: 'checking', error: null })
      wsTimerRef.current = window.setTimeout(() => {
        wsTimerRef.current = null
        void checkWorkspace(next)
      }, 400)
    },
    [checkWorkspace, clearWsTimer]
  )

  const handleWorkspaceBlur = useCallback((): void => {
    clearWsTimer()
    void checkWorkspace(workspace)
  }, [checkWorkspace, clearWsTimer, workspace])

  /** 开始/设为默认前的兜底：valid 直接用，否则现场校验 */
  const ensureWorkspace = useCallback(async (): Promise<boolean> => {
    if (workspaceCheck.status === 'valid') return true
    return checkWorkspace(workspace)
  }, [checkWorkspace, workspace, workspaceCheck.status])

  /** 真正启动任务（草稿和手动「开始」共用；失败时保留输入与附件） */
  const startWith = useCallback(
    async (text: string, files: PickedFile[], targetWorkspace: string): Promise<void> => {
      const api = agentBridge()
      if (!api) {
        setError('任务模式不可用：请重启应用')
        return
      }
      const trimmed = text.trim() || (files.length > 0 ? '帮我看看这些文件' : '')
      if (!trimmed) {
        setError('先说说要做什么')
        return
      }
      clearWsTimer()
      const workspaceOk = await checkWorkspace(targetWorkspace)
      if (!workspaceOk) return
      setError(null)
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
        setError(errorText(err))
        return
      }
      if (!result.ok) {
        setError(result.error ?? '启动失败')
        return
      }
      setTask('')
      clearAttachments()
      setCompose(false)
    },
    [composeMode, clearAttachments, checkWorkspace, clearWsTimer]
  )

  const start = useCallback(async (): Promise<void> => {
    await startWith(task, attachments, workspace)
  }, [startWith, task, attachments, workspace])

  // 宠物窗带文件的消息：预填草稿 + 用默认工作区自动开始；工作区无效时保留草稿并报错
  useEffect(() => {
    if (!draft) return
    const draftId =
      draft.id ?? `${draft.text}|${(draft.attachments ?? []).map((item) => item.path).join('|')}`
    if (handledDraftRef.current === draftId) return
    handledDraftRef.current = draftId
    draftActiveRef.current = true
    onDraftHandled?.(draftId)

    const api = agentBridge()
    if (!api) {
      setError('任务模式不可用：请重启应用')
      return
    }
    const files = (draft.attachments ?? [])
      .map((item) => ({ path: item.path, name: item.name, size: 0 }))
      .filter((file) => unsupportedReason(file) === null)
      .slice(0, MAX_ATTACHMENTS)
    const text = draft.text.trim() || (files.length > 0 ? '帮我看看这些文件' : '')

    setCompose(true)
    setTask(text)
    setAttachments(files)
    setPreviews({})
    setError(null)

    void api
      .getDefaultWorkspace()
      .then((resolved) => {
        setWorkspace(resolved)
        return startWith(text, files, resolved)
      })
      .catch((err) => {
        setError(`默认工作区不可用：${errorText(err)}`)
        setCompose(true)
      })
  }, [draft, onDraftHandled, startWith])

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

  /** 手动选目录：只对当前草稿生效；要长期使用需另点「设为默认」 */
  const pickWorkspace = useCallback(async (): Promise<void> => {
    const api = agentBridge()
    if (!api) return
    try {
      const picked = await api.pickWorkspace()
      if (!picked) return
      clearWsTimer()
      wsSeqRef.current += 1
      setWorkspace(picked)
      setError(null)
      void checkWorkspace(picked)
    } catch (err) {
      setError(errorText(err))
    }
  }, [checkWorkspace, clearWsTimer])

  /** 把当前目录写回 config.toml，下次新任务仍从这里开始 */
  const setWorkspaceAsDefault = useCallback(async (): Promise<void> => {
    const api = agentBridge()
    const target = workspace.trim()
    if (!api || !target) return
    clearWsTimer()
    if (!(await ensureWorkspace())) return
    try {
      const result = await api.setDefaultWorkspace(target)
      if (!result.ok) {
        setWorkspaceCheck({
          status: 'invalid',
          error: result.error ?? '保存默认工作区失败'
        })
        return
      }
    } catch (err) {
      setWorkspaceCheck({ status: 'invalid', error: errorText(err) })
      return
    }
    setWsNotice(`已把「${target}」设为默认工作区`)
    window.setTimeout(() => setWsNotice(null), 4000)
  }, [workspace, ensureWorkspace, clearWsTimer])

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
    // 重新选同一个任务时 state.id 不变，也要清掉上次留下的历史选中文本/附件
    setReply('')
    clearAttachments()
    setFileNotice(null)
    stickRef.current = true
  }, [clearAttachments])

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
  const history = useMemo(() => buildTaskHistory(state), [state])

  /** 手动刷新余额（10 分钟自动刷新由主进程负责） */
  const refreshLlmStatus = useCallback(async (): Promise<void> => {
    const api = agentBridge()
    if (!api || refreshingLlm) return
    setRefreshingLlm(true)
    try {
      setLlmStatus(await api.refreshLlmStatus())
    } catch {
      /* 余额是软功能：失败保持旧值 */
    } finally {
      setRefreshingLlm(false)
    }
  }, [refreshingLlm])

  const showThinkingNotice = useCallback((text: string, error = false): void => {
    if (thinkingNoticeTimer.current !== null) {
      window.clearTimeout(thinkingNoticeTimer.current)
    }
    setThinkingNotice({ text, error })
    thinkingNoticeTimer.current = window.setTimeout(
      () => {
        thinkingNoticeTimer.current = null
        setThinkingNotice(null)
      },
      error ? 4_000 : 2_500
    )
  }, [])

  useEffect(
    () => () => {
      if (thinkingNoticeTimer.current !== null) {
        window.clearTimeout(thinkingNoticeTimer.current)
        thinkingNoticeTimer.current = null
      }
    },
    []
  )

  // 思考强度菜单：点外面 / Esc 关闭
  useEffect(() => {
    if (!thinkingOpen) return
    const onPointerDown = (event: PointerEvent): void => {
      if (!thinkingRef.current?.contains(event.target as Node)) setThinkingOpen(false)
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setThinkingOpen(false)
    }
    window.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [thinkingOpen])

  /** 切换下次新任务的思考强度（当前任务不变） */
  const chooseThinkingLevel = useCallback(
    async (level: string): Promise<void> => {
      const api = agentBridge()
      const current = llmStatus?.thinkingLevel
      setThinkingOpen(false)
      if (!api || savingThinking || !current || level === current) return
      setSavingThinking(true)
      try {
        const result = await api.setThinkingLevel(level as 'low' | 'high' | 'max')
        if (!result.ok) showThinkingNotice(result.error ?? '切换失败', true)
        else showThinkingNotice('下次新任务生效')
      } catch (err) {
        showThinkingNotice(errorText(err), true)
      } finally {
        setSavingThinking(false)
      }
    },
    [llmStatus?.thinkingLevel, savingThinking, showThinkingNotice]
  )

  const activeModel = state?.model || llmStatus?.model || ''
  const modelTitle = state?.model ? '当前任务使用的模型' : '当前配置的模型'
  const taskCost = state?.usage.cost ?? 0
  const balanceTotal = llmStatus?.total ?? null
  const balanceText = !llmStatus
    ? '余额 …'
    : balanceTotal === null
      ? refreshingLlm
        ? '余额 …'
        : '余额 —'
      : `余额 ${formatMoney(balanceTotal, llmStatus.currency)}`
  const balanceStale = Boolean(llmStatus?.code)
  const balanceLow =
    balanceTotal !== null &&
    (llmStatus?.currency ?? '').toUpperCase() === 'CNY' &&
    balanceTotal < 5
  const balanceTitle = [
    balanceTotal !== null && llmStatus
      ? `余额 ${formatMoney(balanceTotal, llmStatus.currency)}` +
        (llmStatus.toppedUp !== null || llmStatus.granted !== null
          ? `（充值 ${
              llmStatus.toppedUp !== null
                ? formatMoney(llmStatus.toppedUp, llmStatus.currency)
                : '—'
            } / 赠送 ${
              llmStatus.granted !== null
                ? formatMoney(llmStatus.granted, llmStatus.currency)
                : '—'
            }）`
          : '')
      : '',
    llmStatus?.message ?? '',
    '每 10 分钟自动刷新，点击立即刷新'
  ]
    .filter((line) => line.length > 0)
    .join('\n')

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
            notice={wsNotice}
            onTaskChange={setTask}
            onDrop={handleDropFiles}
            onRemoveAttachment={removeAttachment}
            onPaste={handlePasteFiles}
            onPickFiles={() => void pickFiles()}
            onPickWorkspace={() => void pickWorkspace()}
            onSetDefaultWorkspace={() => void setWorkspaceAsDefault()}
            workspaceValid={workspaceCheck.status === 'valid'}
            workspaceChecking={workspaceCheck.status === 'checking'}
            workspaceError={workspaceCheck.status === 'invalid' ? workspaceCheck.error : null}
            onWorkspaceChange={handleWorkspaceChange}
            onWorkspaceBlur={handleWorkspaceBlur}
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
              <div className="task-head-meta">
                {state?.workspace ? (
                  <span className="task-workspace" title={state.workspace}>
                    {formatWorkspacePath(state.workspace)}
                  </span>
                ) : null}
                {llmStatus?.showModel && activeModel ? (
                  <div className="task-thinking" ref={thinkingRef}>
                    {llmStatus.thinkingLevels.length > 0 ? (
                      <button
                        type="button"
                        className="task-model task-thinking-btn"
                        title={`${modelTitle}；思考强度 ${llmStatus.thinkingLevel}（点击切换，下次新任务生效）`}
                        aria-haspopup="menu"
                        aria-expanded={thinkingOpen}
                        onClick={() => setThinkingOpen((open) => !open)}
                      >
                        <span>{activeModel}</span>
                        <span className="task-thinking-level">
                          · {llmStatus.thinkingLevel}
                        </span>
                        <span className="task-thinking-caret" aria-hidden="true">
                          ▾
                        </span>
                      </button>
                    ) : (
                      <span className="task-model task-model-static" title={modelTitle}>
                        {activeModel}
                      </span>
                    )}
                    {thinkingOpen ? (
                      <div className="task-thinking-menu" role="menu">
                        <div className="task-thinking-menu-head">思考强度 · 下次新任务生效</div>
                        {llmStatus.thinkingLevels.map((level) => (
                          <button
                            key={level}
                            type="button"
                            role="menuitemradio"
                            aria-checked={level === llmStatus.thinkingLevel}
                            className={`task-thinking-item${
                              level === llmStatus.thinkingLevel
                                ? ' task-thinking-item-active'
                                : ''
                            }`}
                            disabled={savingThinking}
                            onClick={() => void chooseThinkingLevel(level)}
                          >
                            <span>{THINKING_MENU_LABELS[level] ?? level}</span>
                            {level === llmStatus.thinkingLevel ? (
                              <span className="task-thinking-check">✓</span>
                            ) : null}
                          </button>
                        ))}
                      </div>
                    ) : null}
                    {thinkingNotice ? (
                      <span
                        className={`task-thinking-note${
                          thinkingNotice.error ? ' task-thinking-note-error' : ''
                        }`}
                        role="status"
                      >
                        {thinkingNotice.text}
                      </span>
                    ) : null}
                  </div>
                ) : null}
                {llmStatus?.showCost && taskCost > 0 ? (
                  <span
                    className="task-cost"
                    title="按 DeepSeek 官方价估算的本次任务累计费用（高峰/低谷自动折算）"
                  >
                    本次 ≈{formatCost(taskCost)}
                  </span>
                ) : null}
                {llmStatus?.showBalance ? (
                  <button
                    type="button"
                    className={`task-balance${balanceLow ? ' task-balance-low' : ''}${
                      balanceStale ? ' task-balance-stale' : ''
                    }${refreshingLlm ? ' task-balance-busy' : ''}`}
                    title={balanceTitle}
                    aria-label="刷新账户余额"
                    aria-busy={refreshingLlm}
                    onClick={() => void refreshLlmStatus()}
                  >
                    {balanceText}
                    <span className="task-balance-refresh" aria-hidden="true">
                      ↻
                    </span>
                  </button>
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
                showCost={llmStatus?.showCost === true}
                flashId={flashId}
                onAnswer={(id, answer) => void answerQuestion(id, answer)}
                onExecutePlan={(mode) => void executePlan(mode)}
                onLinkClick={onLinkClick}
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
              taskId={state?.id ?? ''}
              history={history}
              onLocateHistory={locateHistoryItem}
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
