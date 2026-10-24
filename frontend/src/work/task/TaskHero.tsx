/** 新任务页：任务输入、附件、工作区、执行模式与开始按钮。 */
import type { DragEvent as ReactDragEvent, ReactElement } from 'react'
import type { ExecutionMode, PickedFile } from '../../../electron/ipc/channels'
import AttachmentStrip from '../message/AttachmentStrip'
import TaskModeSelector, { MODE_HINTS } from './TaskModeSelector'

function PaperclipIcon(): ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
    </svg>
  )
}

export interface TaskHeroProps {
  task: string
  workspace: string
  mode: ExecutionMode
  onModeChange: (mode: ExecutionMode) => void
  attachments: PickedFile[]
  previews: Record<string, string>
  error: string | null
  onTaskChange: (value: string) => void
  onDrop: (event: ReactDragEvent<HTMLDivElement>) => void
  onRemoveAttachment: (path: string) => void
  /** 粘贴的是本机绝对路径时返回 true（并异步读取文件） */
  onPaste: (text: string) => boolean
  onPickFiles: () => void
  onPickWorkspace: () => void
  onStart: () => void
}

export default function TaskHero({
  task,
  workspace,
  mode,
  onModeChange,
  attachments,
  previews,
  error,
  onTaskChange,
  onDrop,
  onRemoveAttachment,
  onPaste,
  onPickFiles,
  onPickWorkspace,
  onStart
}: TaskHeroProps): ReactElement {
  return (
    <div className="task-hero">
      <div className="task-hero-title">你好，要做什么？</div>
      <div className="task-hero-sub">写代码、分析文档、查系统、拆解任务都可以</div>
      <div
        className="task-hero-card"
        onDragOver={(event) => event.preventDefault()}
        onDrop={onDrop}
      >
        <AttachmentStrip files={attachments} previews={previews} onRemove={onRemoveAttachment} />
        <textarea
          className="task-hero-input"
          value={task}
          placeholder="比如：看一下系统盘哪些文件可以清理"
          rows={4}
          onChange={(event) => onTaskChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault()
              onStart()
            }
          }}
          onPaste={(event) => {
            const text = event.clipboardData.getData('text')
            if (onPaste(text)) event.preventDefault()
          }}
        />
        <div className="task-hero-foot">
          <div className="task-hero-tools">
            <button
              type="button"
              className="work-attach"
              title="添加文件 / 图片"
              aria-label="添加文件"
              onClick={onPickFiles}
            >
              <PaperclipIcon />
            </button>
            <button type="button" className="task-ws-btn" onClick={onPickWorkspace}>
              <span className="task-ws-label">工作区</span>
              <span className={`task-ws-value${workspace ? '' : ' task-ws-empty'}`}>
                {workspace || '未选择'}
              </span>
            </button>
            <TaskModeSelector mode={mode} onChange={onModeChange} compact />
          </div>
          <button type="button" className="task-btn task-btn-primary" onClick={onStart}>
            开始
          </button>
        </div>
      </div>
      {error ? <div className="task-error">{error}</div> : null}
      <div className="task-hero-hint">
        {MODE_HINTS[mode]} · Enter 开始，Shift+Enter 换行
      </div>
    </div>
  )
}
