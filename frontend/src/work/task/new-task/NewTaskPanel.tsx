/** 新任务页：任务输入、附件、工作区、执行模式与开始按钮。 */
import { useRef, type DragEvent as ReactDragEvent, type ReactElement } from 'react'
import type { ExecutionMode } from '../../../../electron/ipc/channels'
import AttachmentStrip from '../../input/AttachmentStrip'
import {
  insertRefToken,
  refToken,
  removeRefToken,
  type AttachedFile
} from '../../input/inline-ref'
import { clipboardFileList } from '../../../modules/chat/file-support'
import TaskModeSelector, { MODE_HINTS } from './TaskModeSelector'

function PaperclipIcon(): ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
    </svg>
  )
}

function FolderIcon(): ReactElement {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
    </svg>
  )
}

export interface NewTaskPanelProps {
  task: string
  workspace: string
  mode: ExecutionMode
  onModeChange: (mode: ExecutionMode) => void
  attachments: AttachedFile[]
  previews: Record<string, string>
  error: string | null
  /** 轻提示（如"已设为默认工作区"），不是错误 */
  notice?: string | null
  onTaskChange: (value: string) => void
  onDrop: (event: ReactDragEvent<HTMLDivElement>) => Promise<AttachedFile[]>
  onRemoveAttachment: (path: string) => void
  /** 粘贴的是本机绝对路径时返回 true（并异步读取文件） */
  onPaste: (text: string) => boolean
  /** 剪贴板里的文件/图片对象（与拖拽共用附件逻辑），返回新增附件 */
  onPasteFiles: (files: File[]) => Promise<AttachedFile[]>
  onPickFiles: () => Promise<AttachedFile[]>
  onPickWorkspace: () => void
  onSetDefaultWorkspace: () => void
  /** 工作区是否已通过主进程校验（开始与设为默认都要求 true） */
  workspaceValid: boolean
  workspaceChecking: boolean
  /** 校验失败原因（行内展示；有效时为 null） */
  workspaceError: string | null
  onWorkspaceChange: (value: string) => void
  onWorkspaceBlur: () => void
  onStart: () => void
}

export default function NewTaskPanel({
  task,
  workspace,
  mode,
  onModeChange,
  attachments,
  previews,
  error,
  notice,
  onTaskChange,
  onDrop,
  onRemoveAttachment,
  onPaste,
  onPasteFiles,
  onPickFiles,
  onPickWorkspace,
  onSetDefaultWorkspace,
  workspaceValid,
  workspaceChecking,
  workspaceError,
  onWorkspaceChange,
  onWorkspaceBlur,
  onStart
}: NewTaskPanelProps): ReactElement {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)

  /** 新增附件后，把 [图片1] / [文件1.pdf] 插到光标处 */
  const insertFiles = (added: AttachedFile[]): void => {
    if (added.length === 0) return
    const token = added
      .map((file) => refToken(file.ref ?? file.name))
      .join(' ')
    insertRefToken(textareaRef.current, token, task, onTaskChange)
  }

  /** 删除缩略图时同步删掉正文里的引用标记，避免指向不存在的附件 */
  const removeAttachment = (path: string): void => {
    const ref = attachments.find((file) => file.path === path)?.ref
    onRemoveAttachment(path)
    if (ref) onTaskChange(removeRefToken(task, refToken(ref)))
  }

  return (
    <div className="task-hero">
      <div className="task-hero-title">你好，要做什么？</div>
      <div className="task-hero-sub">写代码、分析文档、查系统、拆解任务都可以</div>
      <div
        className="task-hero-card"
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => void onDrop(event).then(insertFiles)}
      >
        <AttachmentStrip files={attachments} previews={previews} onRemove={removeAttachment} />
        <textarea
          ref={textareaRef}
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
        <div className="task-hero-foot">
          <div className="task-hero-tools">
            <button
              type="button"
              className="work-attach"
              title="添加文件 / 图片"
              aria-label="添加文件"
              onClick={() => void onPickFiles().then(insertFiles)}
            >
              <PaperclipIcon />
            </button>
            <div className="task-ws-wrap">
              <div
                className={`task-ws-field${workspaceError ? ' task-ws-field-invalid' : ''}`}
              >
                <span className="task-ws-label">工作区</span>
                <input
                  className="task-ws-input"
                  value={workspace}
                  placeholder="输入绝对路径，或点右侧选择文件夹"
                  spellCheck={false}
                  autoComplete="off"
                  aria-label="工作区路径"
                  aria-invalid={Boolean(workspaceError)}
                  title={workspace}
                  onChange={(event) => onWorkspaceChange(event.target.value)}
                  onBlur={onWorkspaceBlur}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault()
                      event.currentTarget.blur()
                    }
                  }}
                />
                <button
                  type="button"
                  className="task-ws-pick"
                  title="选择文件夹…"
                  aria-label="选择工作区文件夹"
                  onClick={onPickWorkspace}
                >
                  <FolderIcon />
                </button>
              </div>
              {workspaceError ? (
                <div className="task-ws-error" role="alert">
                  ⚠ {workspaceError}
                </div>
              ) : null}
            </div>
            {workspace.trim() ? (
              <button
                type="button"
                className="task-ws-default"
                title={
                  workspaceValid
                    ? '把这个目录写回 config.toml，作为以后新任务的默认工作区'
                    : workspaceChecking
                      ? '正在校验工作区…'
                      : '工作区不可用，修正后才能设为默认'
                }
                disabled={!workspaceValid || workspaceChecking}
                onClick={onSetDefaultWorkspace}
              >
                设为默认
              </button>
            ) : null}
            <TaskModeSelector mode={mode} onChange={onModeChange} compact />
          </div>
          <button
            type="button"
            className="task-btn task-btn-primary"
            disabled={!workspaceValid || workspaceChecking}
            title={workspaceError ?? undefined}
            onClick={onStart}
          >
            开始
          </button>
        </div>
      </div>
      {error ? <div className="task-error">{error}</div> : null}
      <div className="task-hero-hint">
        {notice ? notice : `${MODE_HINTS[mode]} · Enter 开始，Shift+Enter 换行`}
      </div>
    </div>
  )
}
