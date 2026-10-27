/** 任务消息流：用户回合 / 思考 / 工具调用 / 回合统计 / 回答 / 待办 / 审批。 */
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactElement
} from 'react'
import { renderMarkdownWithCitations } from '../../../board/markdown'
import type { AgentState, AgentStep, AgentTodoItem } from '../../../../electron/ipc/channels'
import { formatCost, formatTokens } from '../../shared/format-value'
import { formatClockTime } from '../../shared/time'
import { handleMarkdownClick } from '../../shared/link'
import { TASK_START_ID } from '../input/input-history'

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
      <span className="work-time">{formatClockTime(at)}</span>
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
const AUTO_OPEN_SECONDS = 10

/** 运行时长：mm:ss（长命令比「47s」更易读） */
function formatElapsed(seconds: number): string {
  const total = Math.max(0, Math.round(seconds))
  const mm = String(Math.floor(total / 60)).padStart(2, '0')
  const ss = String(total % 60).padStart(2, '0')
  return `${mm}:${ss}`
}

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
  // 长命令超过 10s 自动展开详情（每秒的「已运行 N 秒…」看得见），
  // 用户手动收起后本次运行不再自动展开；结束后恢复默认折叠。
  const [autoOpen, setAutoOpen] = useState(false)
  const userCollapsedRef = useRef(false)
  useEffect(() => {
    if (!running) {
      setAutoOpen(false)
      userCollapsedRef.current = false
      return
    }
    if (seconds >= AUTO_OPEN_SECONDS && !userCollapsedRef.current) setAutoOpen(true)
  }, [running, seconds])
  const showDetail = open || autoOpen
  return (
    <div className={`task-tool task-tool-${step.status}`} data-step-id={step.id}>
      <button
        type="button"
        className="task-tool-head"
        onClick={() => {
          if (autoOpen) userCollapsedRef.current = true
          setAutoOpen(false)
          onToggle()
        }}
        title={step.command ?? step.detail ?? ''}
        onContextMenu={(event) => {
          if (!step.command) return
          event.preventDefault()
          event.stopPropagation()
          onCommandMenu(step.command, event.clientX, event.clientY)
        }}
      >
        <span className="task-tool-icon" aria-hidden="true">
          {running ? <span className="task-spinner task-tool-spinner" /> : icon}
        </span>
        <span className="task-tool-title">{step.title}</span>
        {step.command ? <span className="task-tool-cmd">{step.command}</span> : null}
        <span className={`task-tool-meta${running ? ' task-tool-meta-running' : ''}`}>
          {running ? `运行中 ${formatElapsed(seconds)}` : `${seconds.toFixed(1)}s`}
          {step.tokens ? ` · ${formatTokens(step.tokens.input)}/${formatTokens(step.tokens.output)}` : ''}
        </span>
      </button>
      {showDetail && step.detail ? <pre className="task-tool-detail">{step.detail}</pre> : null}
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

/** 单轮统计：耗时 / 调用次数 / token / 缓存命中率 / 费用 / 上下文占用（固定在最终回答之后）。 */
function RoundStats({ step, showCost }: { step: AgentStep; showCost: boolean }): ReactElement {
  const stats = step.stats
  const seconds = Math.max(0, Math.round(((step.endedAt ?? step.startedAt) - step.startedAt) / 1000))
  const mm = String(Math.floor(seconds / 60)).padStart(2, '0')
  const ss = String(seconds % 60).padStart(2, '0')
  // 模型生成速度 = 本轮输出 tokens / 本轮各次调用的生成时长（不含工具执行）
  const generationMs = stats?.generationMs ?? 0
  const generationSeconds = Math.max(0, Math.round(generationMs / 1000))
  const gm = String(Math.floor(generationSeconds / 60)).padStart(2, '0')
  const gs = String(generationSeconds % 60).padStart(2, '0')
  const tokensPerSecond =
    generationMs > 0 && stats
      ? Math.round(stats.output / (generationMs / 1000))
      : 0
  // 命中率按「命中 / 全部输入」算（DeepSeek 的 input 已是未命中部分）
  const promptTokens = stats ? stats.input + stats.cacheRead : 0
  const hitRate =
    stats && promptTokens > 0 ? Math.round((stats.cacheRead / promptTokens) * 100) : 0
  return (
    <div className="task-round-stats">
      本轮耗时 {mm}:{ss}
      {stats ? (
        <>
          <span className="task-stats-sep"> · </span>
          调用 {stats.calls} 次
          {generationMs > 0 ? (
            <>
              <span className="task-stats-sep"> · </span>
              生成 {gm}:{gs}
              {tokensPerSecond > 0 ? <>{` · ${tokensPerSecond}token/s`}</> : null}
            </>
          ) : null}
          <br />
          未命中 {formatTokens(stats.input)} / 命中 {formatTokens(stats.cacheRead)}
          {promptTokens > 0 ? <>（{hitRate}%）</> : null} / 输出{' '}
          {formatTokens(stats.output)} tokens
          {showCost && typeof stats.cost === 'number' ? (
            <>
              <span className="task-stats-sep"> · </span>
              <span title="按 DeepSeek 官方价估算：高峰/低谷自动折算；法定节假日未单独扣除">
                费用 ≈{formatCost(stats.cost)}
              </span>
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

/** 提问卡：模型问你 2–4 选一。点选项只选中，可补充说明，点「回答」才提交。 */
function QuestionCard({
  question,
  onAnswer
}: {
  question: NonNullable<AgentState['question']>
  onAnswer?: (id: string, answer: string) => void
}): ReactElement {
  // 2026-10-26：不再点选项即提交——用户常常选完还想补一句，直接提交会抢跑。
  const [selected, setSelected] = useState<string | null>(null)
  const [extra, setExtra] = useState('')
  const answer = [selected, extra.trim()].filter(Boolean).join('\n补充：')
  const submit = (): void => {
    if (answer) onAnswer?.(question.id, answer)
  }
  return (
    <div className="task-question">
      <div className="task-question-head">
        <span className="task-approval-icon" aria-hidden="true">
          ✦
        </span>
        <span>需要你决定</span>
      </div>
      <div className="task-question-text">{question.question}</div>
      <div className="task-question-options">
        {question.options.map((option) => (
          <button
            key={option}
            type="button"
            className={`task-question-option${selected === option ? ' task-question-option-on' : ''}`}
            aria-pressed={selected === option}
            onClick={() => setSelected(option)}
          >
            {option}
          </button>
        ))}
      </div>
      <div className="task-question-other">
        <input
          className="task-question-input"
          value={extra}
          placeholder={
            selected
              ? '补充说明（可选），会和上面的选择一起发给小兔'
              : '也可以直接输入你的答案'
          }
          onChange={(event) => setExtra(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
              event.preventDefault()
              submit()
            }
          }}
        />
        <button
          type="button"
          className="task-btn task-btn-primary"
          disabled={answer.length === 0}
          onClick={submit}
        >
          回答
        </button>
      </div>
      <div className="task-approval-hint">选好可以再补充说明，点「回答」后小兔才会继续</div>
    </div>
  )
}

export interface AgentFlowProps {
  task?: string
  workspace?: string
  flow: AgentStep[]
  todos: AgentTodoItem[]
  now: number
  expanded: Record<string, boolean>
  copiedId: string | null
  summary?: string
  endedAt?: number
  startedAt?: number
  error?: string
  approval?: AgentState['approval']
  remaining: number
  question?: AgentState['question']
  status?: AgentState['status']
  mode?: AgentState['mode']
  canExecutePlan?: boolean
  /** 历史定位后短暂高亮的锚点 id（TASK_START_ID 或 round 步骤 id） */
  flashId?: string | null
  /** 是否显示每轮费用（设置 → 任务；默认关闭） */
  showCost?: boolean
  onAnswer?: (id: string, answer: string) => void
  onExecutePlan?: (mode: 'standard' | 'auto') => void
  /** 链接点击：与对话模式一致，交由工作窗内嵌浏览器打开 */
  onLinkClick?: (event: ReactMouseEvent<HTMLDivElement>) => void
  onToggle: (step: AgentStep) => void
  onCopy: (id: string, text: string) => void
  onCommandMenu: (command: string, x: number, y: number) => void
  onApprove: (allow: boolean) => void
}

export default function AgentFlow({
  task,
  workspace,
  flow,
  todos,
  now,
  expanded,
  copiedId,
  summary,
  endedAt,
  startedAt,
  error,
  approval,
  remaining,
  question,
  status,
  mode,
  canExecutePlan = false,
  flashId = null,
  showCost = false,
  onAnswer,
  onExecutePlan,
  onLinkClick,
  onToggle,
  onCopy,
  onCommandMenu,
  onApprove
}: AgentFlowProps): ReactElement {
  // 链接优先交给工作窗内嵌浏览器（与对话模式一致）；bridge 不可用时退回系统浏览器
  const handleLinkClick = onLinkClick ?? handleMarkdownClick
  // summary 与已有 text 步骤重复时不再二次渲染；统计仍跟在每轮回答之后
  const summaryText = (summary ?? '').trim()
  const summaryDuplicated =
    summaryText !== '' &&
    flow.some(
      (step) => step.kind === 'text' && (step.detail ?? '').trim() === summaryText
    )

  return (
    <div className="task-flow">
      {task ? (
        <div
          className={`task-start-line${flashId === TASK_START_ID ? ' task-locate-flash' : ''}`}
          data-step-id={TASK_START_ID}
          title={workspace}
        >
          <span className="task-start-mark" aria-hidden="true">
            ✦
          </span>
          <span>{task}</span>
          <span className="task-start-ws">{workspace}</span>
        </div>
      ) : null}

      {todos.length > 0 ? <TodoList items={todos} /> : null}

      {flow.map((step) => {
        if (step.kind === 'round') {
          return (
            <div
              className={`task-msg task-msg-user${flashId === step.id ? ' task-locate-flash' : ''}`}
              data-step-id={step.id}
              key={step.id}
            >
              <div className="task-bubble">{step.title}</div>
              <MessageMeta
                at={step.startedAt}
                copied={copiedId === step.id}
                onCopy={() => onCopy(step.id, step.title)}
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
              onToggle={() => onToggle(step)}
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
              onToggle={() => onToggle(step)}
              onCommandMenu={onCommandMenu}
            />
          )
        }
        if (step.kind === 'stats') {
          return <RoundStats key={step.id} step={step} showCost={showCost} />
        }
        if (step.kind === 'text') {
          return (
            <div className="task-msg task-msg-assistant" key={step.id}>
              {step.detail ? (
                <div
                  className="md-body work-markdown task-md"
                  onClick={handleLinkClick}
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
                onCopy={() => onCopy(step.id, step.detail ?? '')}
              />
            </div>
          )
        }
        return null
      })}

      {approval ? (
        <div className={`task-approval${approval.dangerous ? ' task-approval-danger' : ''}`}>
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
            <button type="button" className="task-btn" onClick={() => onApprove(false)}>
              拒绝
            </button>
            <button
              type="button"
              className="task-btn task-btn-primary"
              onClick={() => onApprove(true)}
            >
              允许
            </button>
          </div>
          <div className="task-approval-hint">不操作将自动拒绝</div>
        </div>
      ) : null}

      {question ? (
        <QuestionCard key={question.id} question={question} onAnswer={onAnswer} />
      ) : null}

      {summary && !summaryDuplicated ? (
        <div className="task-msg task-msg-assistant">
          <div
            className="md-body work-markdown task-md"
            onClick={handleLinkClick}
            dangerouslySetInnerHTML={{
              __html: renderMarkdownWithCitations(summary)
            }}
          />
          <MessageMeta
            at={endedAt ?? startedAt ?? Date.now()}
            copied={copiedId === 'summary'}
            onCopy={() => onCopy('summary', summary)}
          />
        </div>
      ) : null}

      {status === 'planned' ? (
        <div className="task-plan-card">
          <div className="task-plan-head">✦ 计划已完成</div>
          <div className="task-plan-text">
            {canExecutePlan
              ? '选择执行模式后，在同一任务里继续（保留当前计划和上下文）。'
              : '任务上下文已释放，无法直接执行；请新开任务并把计划贴过去。'}
          </div>
          <div className="task-plan-actions">
            <button
              type="button"
              className="task-btn task-btn-primary"
              disabled={!canExecutePlan}
              onClick={() => onExecutePlan?.('standard')}
            >
              按标准执行
            </button>
            <button
              type="button"
              className="task-btn"
              disabled={!canExecutePlan}
              onClick={() => onExecutePlan?.('auto')}
            >
              按自动执行
            </button>
          </div>
          <div className="task-plan-hint">
            {mode === 'plan' ? '当前仍是计划模式；点上面按钮会切出只读。' : ''}
          </div>
        </div>
      ) : null}

      {error ? <div className="task-error">{error}</div> : null}
    </div>
  )
}
