/** 任务进行中的输入条：附件、历史、追问、发送/中止。 */
import { useRef, type DragEvent as ReactDragEvent, type ReactElement } from 'react'
import type { PickedFile } from '../../../electron/ipc/channels'
import { Textarea } from '../../shared/ui/components/Textarea'
import { clipboardFileList } from '../../modules/chat/file-support'
import AttachmentStrip from '../message/AttachmentStrip'
import {
  ComposerHistoryButton,
  ComposerHistoryPopover,
  useComposerHistory
} from '../message/ComposerHistory'
import type { ComposerHistoryItem } from '../message/chat-history'

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

export interface ComposerBarProps {
  value: string
  busy: boolean
  resumable?: boolean
  status?: string
  attachments: PickedFile[]
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
  onDrop: (event: ReactDragEvent<HTMLDivElement>) => void
  onRemoveAttachment: (path: string) => void
  /** 粘贴的是本机绝对路径时返回 true（并异步读取文件） */
  onPaste: (text: string) => boolean
  /** 剪贴板里的文件/图片对象（与拖拽共用附件逻辑） */
  onPasteFiles: (files: File[]) => void
  onPickFiles: () => void
  onSend: () => void
  onStop: () => void
}

export default function ComposerBar({
  value,
  busy,
  resumable,
  status,
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

  return (
    <div className="task-composer" onDragOver={(event) => event.preventDefault()} onDrop={onDrop}>
      <AttachmentStrip files={attachments} previews={previews} onRemove={onRemoveAttachment} />
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
              onPasteFiles(files)
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
            onClick={onPickFiles}
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
