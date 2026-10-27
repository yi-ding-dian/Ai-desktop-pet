/**
 * 工作窗「任务」标签页（2026-10-23）。
 *
 * 布局：左侧任务列表 + 右侧消息流（我右 / 模型左），底部输入条。
 * 数据：任务状态来自主进程 agent 域（多 Session），面板挂载时补拉，之后靠推送刷新。
 *
 * 展示细节拆在同目录：TaskList（左栏）/ AgentFlow（消息流）/ NewTaskPanel（新任务）
 * / ComposerBar（输入条）/ HoverCard（悬浮预览）。
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
import type {
  AgentState,
  AgentStep,
  AgentTaskDraftPayload,
  AgentTaskSummary,
  ExecutionMode
} from '../../../electron/ipc/channels'
import { MAX_ATTACHMENTS, unsupportedReason } from '../../modules/chat/file-support'
import { groupByTime } from '../shared/time'
import LinkPreviewCard from '../conversation/LinkPreviewCard'
import { useLinkHover } from '../conversation/useLinkHover'
import AgentFlow from './agent-flow/AgentFlow'
import ComposerBar from './input/ComposerBar'
import HoverCard from './agent-flow/HoverCard'
import { buildTaskHistory } from './input/input-history'
import NewTaskPanel from './new-task/NewTaskPanel'
import TaskList from './list/TaskList'
import TaskModeSelector from './new-task/TaskModeSelector'
import { agentBridge } from './agent-bridge'
import { errorText } from './error-text'
import { useTaskDeletion } from './list/useTaskDeletion'
import { useTaskAttachments } from './useTaskAttachments'
import { useTaskExecution } from './useTaskExecution'
import { useTaskFlow } from './useTaskFlow'
import { useTaskSidebar } from './useTaskSidebar'
import { useTaskWorkspace } from './useTaskWorkspace'
import TaskStatusBar from './model-status/TaskStatusBar'
import { useTaskStatus } from './model-status/useTaskStatus'
import TaskContextMenu, { type TaskMenu } from './TaskContextMenu'

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

/** 新任务页选中的执行模式（默认计划：先只读交流，用户明确要动手再点「按此执行」） */
const DEFAULT_COMPOSE_MODE: ExecutionMode = 'plan'

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
export default function TaskPanel({
  focusTaskId = null,
  onFocusHandled,
  onLinkClick,
  draft = null,
  onDraftHandled
}: TaskPanelProps = {}): ReactElement {
  const [state, setState] = useState<AgentState | null>(null)
  /** 顶部：模型/余额/思考强度（2026-10-26 抽到 useTaskStatus） */
  const status = useTaskStatus(state)
  /**
   * 新任务页选中的执行模式。
   *
   * 2026-10-26 起不再用 localStorage 记住上次选择：之前记住「计划」后，
   * 之后每个新任务都沿用，用户以为程序有 bug。默认值固定为计划（只读），
   * 本会话内手动切换仍立即生效。
   */
  const [composeMode, setComposeMode] = useState<ExecutionMode>(DEFAULT_COMPOSE_MODE)
  const [tasks, setTasks] = useState<AgentTaskSummary[]>([])
  const [task, setTask] = useState('')
  const [error, setError] = useState<string | null>(null)
  /** 工作区：默认加载、校验、选择目录、设为默认（2026-10-26 抽到 useTaskWorkspace） */
  const {
    workspace,
    setWorkspace,
    workspaceCheck,
    wsNotice,
    clearWsTimer,
    checkWorkspace,
    ensureWorkspace,
    handleWorkspaceChange,
    handleWorkspaceBlur,
    pickWorkspace,
    setWorkspaceAsDefault
  } = useTaskWorkspace({ onError: setError })
  const [compose, setCompose] = useState(true)
  const [reply, setReply] = useState('')
  const [now, setNow] = useState(() => Date.now())
  /** 本轮附件：选择/拖入/粘贴/预览（2026-10-26 抽到 useTaskAttachments） */
  const {
    attachments,
    previews,
    fileNotice,
    setFileNotice,
    setAttachments,
    setPreviews,
    toAgentAttachments,
    addFiles,
    pickFiles,
    removeAttachment,
    clearAttachments,
    addFileObjects,
    handleDropFiles,
    handlePasteFiles
  } = useTaskAttachments()
  /** 左侧列表宽度与折叠态 */
  const sidebar = useTaskSidebar()
  /** 引用/来源链接卡片：来源来自联网工具（AgentState.sources） */
  const linkHover = useLinkHover(state?.sources, state?.summary)
  /** 消息流交互：滚动/展开/复制/悬浮卡片/历史定位（2026-10-26 抽到 useTaskFlow） */
  const {
    scrollRef,
    stickRef,
    showJump,
    flashId,
    copiedId,
    expanded,
    hoverCard,
    clearHoverCard,
    markCopied,
    handleCopyStep,
    handleFlowHover,
    handleFlowOut,
    handleFlowClick,
    handleScroll,
    jumpToBottom,
    locateHistoryItem,
    toggleExpanded,
    resetHighlight
  } = useTaskFlow({ linkHover, onNotice: setFileNotice })
  /** 右键菜单（任务 = 删除；选中文字 = 复制） */
  const [menu, setMenu] = useState<TaskMenu | null>(null)
  /** 已处理过的草稿 id（防止重渲染/重复事件把同一份文件启动两次） */
  const handledDraftRef = useRef<string | null>(null)
  /** 处理过草稿后保持 true：压住 getState/状态推送的「切到已有任务」，避免把草稿页藏掉 */
  const draftActiveRef = useRef(false)

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
      .then((llm) => {
        if (alive) status.onLlmStatus(llm)
      })
      .catch(() => {
        /* 余额是软功能：拿不到就不显示 */
      })
    const offState = api.onState((snapshot) => {
      setState(snapshot)
      if (snapshot.status !== 'idle' && !draftActiveRef.current) setCompose(false)
    })
    const offTasks = api.onTasks((list) => setTasks(list))
    const offLlm = api.onLlmStatus((llm) => status.onLlmStatus(llm))
    return () => {
      alive = false
      offState()
      offTasks()
      offLlm()
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

  // 任务删除（单条/批量）：列表由主进程 pushTasks 刷新，这里只负责调用与错误提示
  const closeTaskMenu = useCallback((): void => setMenu(null), [])
  const { deleteTask, deleteTasks } = useTaskDeletion({
    onStart: closeTaskMenu,
    onError: setError
  })

  // 切换任务：清掉上一条历史选中文本、附件和定位高亮
  useEffect(() => {
    resetHighlight()
    setReply('')
    clearAttachments()
    setFileNotice(null)
  }, [state?.id, clearAttachments, resetHighlight])

  /** 切换任务后恢复「跟随到底」 */
  const stickToBottom = useCallback((): void => {
    stickRef.current = true
  }, [stickRef])

  // 任务执行：启动/发送/切换/审批/回答/计划（2026-10-26 抽到 useTaskExecution）
  const {
    startWith,
    start,
    send,
    selectTask,
    approve,
    changeMode,
    answerQuestion,
    executePlan
  } = useTaskExecution({
    composeMode,
    task,
    reply,
    workspace,
    attachments,
    state,
    checkWorkspace,
    clearWsTimer,
    clearAttachments,
    toAgentAttachments,
    onError: setError,
    onReplyChange: setReply,
    onTaskChange: setTask,
    onComposeChange: setCompose,
    onFileNotice: setFileNotice,
    stickToBottom
  })

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
  }, [])

  // 通知点击：切到指定任务
  useEffect(() => {
    if (!focusTaskId) return
    void selectTask(focusTaskId).then(() => onFocusHandled?.())
  }, [focusTaskId, onFocusHandled, selectTask])

  const groups = useMemo(
    () => groupByTime(tasks, (task) => task.updatedAt || task.createdAt),
    [tasks]
  )
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
  /** 当前正在跑的命令/工具（输入框上方常驻状态条用） */
  const runningStep = useMemo<AgentStep | null>(() => {
    const steps = state?.steps ?? []
    for (let index = steps.length - 1; index >= 0; index -= 1) {
      const step = steps[index]
      if (step.kind === 'tool' && step.status === 'running') return step
    }
    return null
  }, [state])

  return (
    <div className="task-layout">
      <TaskList
        groups={groups}
        collapsed={sidebar.collapsed}
        width={sidebar.width}
        compose={compose}
        activeId={state?.id}
        onNew={() => setCompose(true)}
        onExpand={sidebar.expand}
        onSelect={(id) => void selectTask(id)}
        onContextMenu={(taskId, x, y) => setMenu({ kind: 'task', taskId, x, y })}
        onDeleteMany={(ids) => void deleteTasks(ids)}
        onResizeStart={sidebar.onResizeStart}
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
          <NewTaskPanel
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
            onPasteFiles={addFileObjects}
            onPickFiles={pickFiles}
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
              <TaskStatusBar
                workspace={state?.workspace ?? ''}
                llmStatus={status.llmStatus}
                refreshingLlm={status.refreshingLlm}
                thinkingOpen={status.thinkingOpen}
                savingThinking={status.savingThinking}
                thinkingNotice={status.thinkingNotice}
                thinkingRef={status.thinkingRef}
                activeModel={status.activeModel}
                modelTitle={status.modelTitle}
                taskCost={status.taskCost}
                balanceText={status.balanceText}
                balanceTitle={status.balanceTitle}
                balanceLow={status.balanceLow}
                balanceStale={status.balanceStale}
                onToggleThinking={status.toggleThinking}
                onChooseThinking={(level) => void status.chooseThinkingLevel(level)}
                onRefresh={() => void status.refreshLlmStatus()}
              />
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
              onMouseLeave={clearHoverCard}
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
                showCost={status.llmStatus?.showCost === true}
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
              runningStep={runningStep}
              now={now}
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
              onPasteFiles={addFileObjects}
              onPickFiles={pickFiles}
              onLocateStep={(step) =>
                locateHistoryItem({ id: step.id, text: step.title, at: step.startedAt })
              }
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
        <TaskContextMenu
          menu={menu}
          onClose={closeTaskMenu}
          onDeleteTask={(id) => void deleteTask(id)}
        />
      ) : null}
    </div>
  )
}
