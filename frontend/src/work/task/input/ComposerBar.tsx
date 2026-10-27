/** 任务进行中的输入条：附件、历史、追问、发送/中止。 */
import { useRef, type DragEvent as ReactDragEvent, type ReactElement } from 'react'
import type { AgentStep } from '../../../../electron/ipc/channels'
import { Textarea } from '../../../shared/ui/components/Textarea'
import { clipboardFileList } from '../../../modules/chat/file-support'
import AttachmentStrip from '../../input/AttachmentStrip'
import {
  insertRefToken,
  refToken,
  removeRefToken,
  type AttachedFile
} from '../../input/inline-ref'
import {
  ComposerHistoryButton,
  ComposerHistoryPopover,
  useComposerHistory
} from '../../input/ComposerHistory'
import type { ComposerHistoryItem } from '../../input/chat-history'

function PaperclipIcon(): ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
    </svg>
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

/** 运行条计时：mm:ss（长命令比「47s」更直观） */
function formatRunningTime(step: AgentStep, now: number): string {
  const seconds = Math.max(0, Math.round(((step.endedAt ?? now) - step.startedAt) / 1000))
  const mm = String(Math.floor(seconds / 60)).padStart(2, '0')
  const ss = String(seconds % 60).padStart(2, '0')
  return `${mm}:${ss}`
}

export interface ComposerBarProps {
  value: string
  busy: boolean
  resumable?: boolean
  status?: string
  /** 当前正在运行的工具步骤（长命令时在输入框上方常驻显示） */
  runningStep?: AgentStep | null
  /** 计时基准（每秒刷新，运行条据此显示已运行时长） */
  now?: number
  attachments: AttachedFile[]
  previews: Record<string, string>
  notice: string | null
  error: string | null
  /** 当前任务 id：切换任务时清空历史翻阅状态 */
  taskId: string
  /** 本任务已发送的消息（最旧在前、最新在后） */
  history: ComposerHistoryItem[]
  /** 点击历史条目的时间：定位到消息流里的原文 */
  onLocateHistory: (item: ComposerHistoryItem) => void
  onValueChange: (value: string) => void
  onDrop: (event: ReactDragEvent<HTMLDivElement>) => Promise<AttachedFile[]>
  onRemoveAttachment: (path: string) => void
  /** 粘贴的是本机绝对路径时返回 true（并异步读取文件） */
  onPaste: (text: string) => boolean
  /** 剪贴板里的文件/图片对象（与拖拽共用附件逻辑），返回新增附件 */
  onPasteFiles: (files: File[]) => Promise<AttachedFile[]>
  onPickFiles: () => Promise<AttachedFile[]>
  /** 点击运行条：定位到消息流里正在跑的那一行 */
  onLocateStep?: (step: AgentStep) => void
  onSend: () => void
  onStop: () => void
}

export default function ComposerBar({
  value,
  busy,
  resumable,
  status,
  runningStep = null,
  now = Date.now(),
  attachments,
  previews,
  notice,
  error,
  taskId,
  history,
  onLocateHistory,
  onValueChange,
  onDrop,
  onRemoveAttachment,
  onPaste,
  onPasteFiles,
  onPickFiles,
  onLocateStep,
  onSend,
  onStop
}: ComposerBarProps): ReactElement {
  const inputDisabled = !resumable || status === 'waiting' || status === 'queued'
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const historyControls = useComposerHistory({
    value,
    onValueChange,
    history,
    scopeKey: taskId,
    onLocate: onLocateHistory,
    textareaRef,
    fillDisabled: inputDisabled
  })

  const sendNow = (): void => {
    historyControls.reset()
    onSend()
  }

  /** 新增附件后，把 [图片1] / [文件1.pdf] 插到光标处 */
  const insertFiles = (added: AttachedFile[]): void => {
    if (added.length === 0) return
    const token = added.map((file) => refToken(file.ref ?? file.name)).join(' ')
    insertRefToken(textareaRef.current, token, value, onValueChange)
  }

  /** 删除缩略图时同步删掉正文里的引用标记 */
  const removeAttachment = (path: string): void => {
    const ref = attachments.find((file) => file.path === path)?.ref
    onRemoveAttachment(path)
    if (ref) onValueChange(removeRefToken(value, refToken(ref)))
  }

  return (
    <div
      className="task-composer"
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => void onDrop(event).then(insertFiles)}
    >
      {runningStep ? (
        <div className="task-running-bar">
          <span className="task-spinner" aria-hidden="true" />
          <span className="task-running-label">正在执行</span>
          <code
            className="task-running-cmd"
            title={runningStep.command ?? runningStep.title}
          >
            {runningStep.command ?? runningStep.title}
          </code>
          <span className="task-running-time">{formatRunningTime(runningStep, now)}</span>
          <button
            type="button"
            className="task-running-action"
            onClick={() => onLocateStep?.(runningStep)}
          >
            定位
          </button>
          <button type="button" className="task-running-action" onClick={onStop}>
            中止
          </button>
        </div>
      ) : null}
      <AttachmentStrip files={attachments} previews={previews} onRemove={removeAttachment} />
      {error || notice ? <div className="task-notice">{error ?? notice}</div> : null}
      <div className="work-input-shell">
        <ComposerHistoryButton controls={historyControls} />
        <Textarea
          className="work-input"
          value={value}
          autoGrow
          maxRows={8}
          rows={1}
          textareaRef={textareaRef}
          disabled={inputDisabled}
          placeholder={
            status === 'queued'
              ? '任务在排队，开始后可以继续插话'
              : !resumable
                ? '这个任务的上下文已释放，点「新任务」重新开始'
                : status === 'planned'
                  ? '计划已生成：可继续讨论，或点「按此执行」'
                  : status === 'waiting'
                    ? '请先处理上方的确认/提问'
                    : busy
                      ? '任务进行中，可以插话…（Enter 发送）'
                      : '接着说点什么…（Enter 发送，Shift+Enter 换行）'
          }
          aria-label="任务输入"
          onValueChange={historyControls.onInputChange}
          onKeyDown={(event) => {
            if (historyControls.handleInputKeyDown(event)) return
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault()
              if (resumable && value.trim()) sendNow()
            }
          }}
          onPaste={(event) => {
            const files = clipboardFileList(event)
            if (files.length > 0) {
              event.preventDefault()
              void onPasteFiles(files).then(insertFiles)
              return
            }
            const text = event.clipboardData.getData('text')
            if (onPaste(text)) event.preventDefault()
          }}
        />
        <div className="work-input-actions">
          <button
            type="button"
            className="work-attach"
            title="添加文件 / 图片"
            aria-label="添加文件"
            onClick={() => void onPickFiles().then(insertFiles)}
          >
            <PaperclipIcon />
          </button>
          {busy ? (
            <button
              type="button"
              className="work-send work-send-stop"
              title="中止任务"
              aria-label="中止"
              onClick={onStop}
            >
              <StopIcon />
            </button>
          ) : (
            <button
              type="button"
              className="work-send"
              title="发送（Enter）"
              aria-label="发送"
              disabled={!value.trim() || !resumable}
              onClick={sendNow}
            >
              <SendIcon />
            </button>
          )}
        </div>

        <ComposerHistoryPopover controls={historyControls} />
      </div>
    </div>
  )
}
