/**
 * 工作模式输入条（2026-10-18）。
 *
 * - 自增高 textarea：Enter 发送、Shift+Enter 换行、IME 组合期不发送；
 * - 附件：回形针 / 拖入 / 粘贴绝对路径（复用 chat 域的 file-support 校验）；
 * - 单轮开关：智能搜索（状态由父组件持久化）；
 * - 流式中发送钮切换为停止（打断经主进程中继到宠物窗）。
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type ReactElement
} from 'react'
import type { PickedFile } from '../../electron/ipc/channels'
import { Textarea } from '../shared/ui/components/Textarea'
import {
  MAX_ATTACHMENTS,
  SUPPORTED_FILE_HINT,
  attachmentKindOf,
  clipboardFileList,
  filesBridge,
  filesFromFileList,
  looksLikeAbsolutePath,
  unsupportedReason
} from '../modules/chat/file-support'
import {
  createRefCounters,
  insertRefToken,
  nextAttachmentRef,
  refToken,
  removeRefToken,
  type AttachedFile
} from './input/inline-ref'
import {
  ComposerHistoryButton,
  ComposerHistoryPopover,
  useComposerHistory
} from './input/ComposerHistory'
import type { ComposerHistoryItem } from './input/chat-history'
import type { WorkNotice } from './store'

export interface ComposerProps {
  streaming: boolean
  search: boolean
  onSearchChange: (value: boolean) => void
  onSend: (text: string, attachments: AttachedFile[]) => Promise<boolean>
  onStop: () => void
  notice: WorkNotice | null
  onDismissNotice: () => void
  /** 当前会话已发送的用户消息（最旧在前） */
  history: ComposerHistoryItem[]
  /** 切换会话时重置历史翻阅 */
  scopeKey: string
  /** 点击历史条目的时间：定位到消息流 */
  onLocateHistory: (item: ComposerHistoryItem) => void
}

export default function Composer({
  streaming,
  search,
  onSearchChange,
  onSend,
  onStop,
  notice,
  onDismissNotice,
  history,
  scopeKey,
  onLocateHistory
}: ComposerProps): ReactElement {
  const [input, setInput] = useState('')
  const [attachments, setAttachments] = useState<AttachedFile[]>([])
  const [localNotice, setLocalNotice] = useState<string | null>(null)
  const [dragActive, setDragActive] = useState(false)
  const dragDepth = useRef(0)
  const sendingRef = useRef(false)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  /** 与 attachments 同步的即时列表（addFiles 要同步返回新增项） */
  const attachmentsRef = useRef<AttachedFile[]>([])
  /** 引用编号：删除不重排，切换会话时归零 */
  const countersRef = useRef(createRefCounters())
  const historyControls = useComposerHistory({
    value: input,
    onValueChange: setInput,
    history,
    scopeKey,
    onLocate: onLocateHistory,
    textareaRef
  })

  // 切换会话 / 对话↔任务标签：清掉本会话的草稿、附件和历史选中文本。
  // （历史 hook 只重置翻阅游标，输入内容归本组件的本地 state）
  useEffect(() => {
    setInput('')
    setAttachments([])
    attachmentsRef.current = []
    countersRef.current = createRefCounters()
    setLocalNotice(null)
    setDragActive(false)
    dragDepth.current = 0
  }, [scopeKey])

  const showLocal = useCallback((text: string): void => {
    setLocalNotice(text)
    window.setTimeout(() => setLocalNotice((current) => (current === text ? null : current)), 4000)
  }, [])

  const addFiles = useCallback(
    (files: PickedFile[]): AttachedFile[] => {
      if (files.length === 0) return []
      const supported: PickedFile[] = []
      const rejected: PickedFile[] = []
      for (const file of files) {
        if (unsupportedReason(file) === null) supported.push(file)
        else rejected.push(file)
      }
      if (rejected.length > 0) {
        const names = rejected.slice(0, 3).map((file) => file.name).join('、')
        showLocal(`「${names}」暂时看不了～${SUPPORTED_FILE_HINT}`)
      }
      if (supported.length === 0) return []
      const merged = [...attachmentsRef.current]
      const added: AttachedFile[] = []
      let full = false
      for (const file of supported) {
        if (merged.some((item) => item.path === file.path)) continue
        if (merged.length >= MAX_ATTACHMENTS) {
          full = true
          break
        }
        const withRef: AttachedFile = {
          ...file,
          ref: nextAttachmentRef(file.name, attachmentKindOf(file), countersRef.current)
        }
        merged.push(withRef)
        added.push(withRef)
      }
      if (full) showLocal(`一次最多带 ${MAX_ATTACHMENTS} 个文件`)
      if (added.length > 0) {
        attachmentsRef.current = merged
        setAttachments(merged)
      }
      return added
    },
    [showLocal]
  )

  /** 新增附件后，把 [图片1] / [文件1.pdf] 插到光标处 */
  const insertFiles = useCallback(
    (added: AttachedFile[]): void => {
      if (added.length === 0) return
      const token = added.map((file) => refToken(file.ref ?? file.name)).join(' ')
      insertRefToken(textareaRef.current, token, input, setInput)
    },
    [input]
  )

  /** 删除附件时同步删掉正文里的引用标记 */
  const removeAttachment = (file: AttachedFile): void => {
    const next = attachmentsRef.current.filter((item) => item.path !== file.path)
    attachmentsRef.current = next
    setAttachments(next)
    const ref = file.ref
    if (ref) setInput((previous) => removeRefToken(previous, refToken(ref)))
  }

  const handlePick = useCallback(async (): Promise<void> => {
    const bridge = filesBridge()
    if (!bridge?.pick) {
      showLocal('当前版本不支持选择文件～')
      return
    }
    try {
      insertFiles(addFiles(await bridge.pick()))
    } catch (err) {
      console.warn('[work] 选择文件失败：', err)
      showLocal('打开文件选择框失败，再试一次好吗？')
    }
  }, [addFiles, insertFiles, showLocal])

  const handlePaste = useCallback(
    async (event: ClipboardEvent<HTMLTextAreaElement>): Promise<void> => {
      const files = clipboardFileList(event)
      if (files.length > 0) {
        // 必须在 await 前 preventDefault，否则图片/文件也会被浏览器塞进输入框
        event.preventDefault()
        const picked = await filesFromFileList(files)
        if (picked.length === 0) {
          showLocal('没有识别到可添加的文件（网页里的文件请先保存到本地）～')
          return
        }
        insertFiles(addFiles(picked))
        return
      }
      const raw = event.clipboardData.getData('text/plain').trim()
      if (!raw || !looksLikeAbsolutePath(raw)) return
      event.preventDefault()
      const bridge = filesBridge()
      if (!bridge?.stat) {
        setInput((previous) => (previous ? `${previous}${raw}` : raw))
        return
      }
      try {
        const file = await bridge.stat(raw)
        if (file === null || file === undefined) {
          setInput((previous) => (previous ? `${previous}${raw}` : raw))
          return
        }
        insertFiles(addFiles([file]))
      } catch {
        setInput((previous) => (previous ? `${previous}${raw}` : raw))
      }
    },
    [addFiles, insertFiles, showLocal]
  )

  const handleDrop = useCallback(
    async (event: DragEvent<HTMLDivElement>): Promise<void> => {
      event.preventDefault()
      dragDepth.current = 0
      setDragActive(false)
      const files = Array.from(event.dataTransfer.files)
      if (files.length === 0) return
      const bridge = filesBridge()
      if (!bridge?.pathFor || !bridge.stat) {
        showLocal('当前版本不支持拖入文件～')
        return
      }
      const paths = files
        .slice(0, MAX_ATTACHMENTS * 4)
        .map((file) => bridge.pathFor?.(file) ?? '')
        .filter((path) => path.length > 0)
      if (paths.length === 0) {
        showLocal('没有识别到本地文件（网页里的文件请先保存到本地）～')
        return
      }
      const checked = await Promise.all(paths.map((path) => bridge.stat?.(path)))
      const picked = checked.filter(
        (item): item is PickedFile => item !== null && item !== undefined
      )
      insertFiles(addFiles(picked))
    },
    [addFiles, insertFiles, showLocal]
  )

  const submit = useCallback(async (): Promise<void> => {
    const text = input.trim()
    if (!text && attachments.length === 0) return
    // 回执最慢可能到 8s（主进程超时）：防连按/连 Enter 重复发送
    if (sendingRef.current) return
    sendingRef.current = true
    historyControls.reset()
    try {
      const ok = await onSend(text || '帮我看看这个文件', attachments)
      if (!ok) return
      setInput('')
      setAttachments([])
      attachmentsRef.current = []
      countersRef.current = createRefCounters()
    } finally {
      sendingRef.current = false
    }
  }, [attachments, historyControls, input, onSend])

  const noticeText = localNotice ?? notice?.text ?? null
  const noticeKind = localNotice !== null ? 'warn' : (notice?.kind ?? 'info')

  return (
    <div
      className={`work-composer${dragActive ? ' work-composer-drag' : ''}`}
      onDragEnter={(event) => {
        event.preventDefault()
        dragDepth.current += 1
        setDragActive(true)
      }}
      onDragOver={(event) => event.preventDefault()}
      onDragLeave={(event) => {
        event.preventDefault()
        dragDepth.current = Math.max(0, dragDepth.current - 1)
        if (dragDepth.current === 0) setDragActive(false)
      }}
      onDrop={(event) => void handleDrop(event)}
    >
      {noticeText !== null ? (
        <div className={`work-composer-notice work-composer-notice-${noticeKind}`} role="status">
          <span>{noticeText}</span>
          <button
            type="button"
            className="work-composer-notice-close"
            aria-label="关闭提示"
            onClick={() => {
              setLocalNotice(null)
              onDismissNotice()
            }}
          >
            ×
          </button>
        </div>
      ) : null}

      {dragActive ? <div className="work-drop-hint">松开鼠标，把文件加到对话里</div> : null}

      {attachments.length > 0 ? (
        <div className="work-attachments">
          {attachments.map((file) => (
            <span
              className="work-attachment"
              key={file.path}
              title={file.ref ? `${file.ref} · ${file.path}` : file.path}
            >
              <span className="work-attachment-name">{file.ref ?? file.name}</span>
              <button
                type="button"
                className="work-attachment-remove"
                aria-label={`移除 ${file.ref ?? file.name}`}
                onClick={() => removeAttachment(file)}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      ) : null}

      <div className="work-input-shell">
        <ComposerHistoryButton controls={historyControls} />
        <Textarea
          className="work-input"
          value={input}
          autoGrow
          maxRows={10}
          rows={1}
          textareaRef={textareaRef}
          placeholder="说点什么…（Enter 发送，Shift+Enter 换行）"
          aria-label="工作模式输入"
          onValueChange={historyControls.onInputChange}
          onPaste={(event) => void handlePaste(event)}
          onKeyDown={(event) => {
            if (historyControls.handleInputKeyDown(event)) return
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault()
              void submit()
            }
          }}
        />

        <div className="work-input-actions">
          <button
            type="button"
            className="work-attach"
            title="添加文件 / 图片"
            aria-label="添加文件"
            onClick={() => void handlePick()}
          >
            <PaperclipIcon />
          </button>
          {streaming ? (
            <button
              type="button"
              className="work-send work-send-stop"
              title="打断当前回复"
              aria-label="停止"
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
              disabled={input.trim().length === 0 && attachments.length === 0}
              onClick={() => void submit()}
            >
              <SendIcon />
            </button>
          )}
        </div>

        <ComposerHistoryPopover controls={historyControls} />
      </div>

      <div className="work-modes">
        <button
          type="button"
          className={`work-mode${search ? ' work-mode-on' : ''}`}
          aria-pressed={search}
          title="需要事实信息时优先联网核实"
          onClick={() => onSearchChange(!search)}
        >
          <SearchIcon />
          智能搜索
        </button>
      </div>
    </div>
  )
}

// ------------------------------------------------------------------ 图标（线稿，currentColor）

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

function SearchIcon(): ReactElement {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </svg>
  )
}
