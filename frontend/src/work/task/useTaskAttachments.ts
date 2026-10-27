/**
 * 任务附件（2026-10-26 从 TaskPanel 抽出）。
 *
 * 负责：选择/拖入/粘贴的本地文件与图片、类型过滤、去重、数量上限、
 * 图片预览（主进程读 dataURL）。附件只引用原路径，不复制文件。
 *
 * 2026-10-27：每个附件分配正文引用名（图片1 / 文件1.pdf），
 * 添加时返回新增项，输入框据此在光标处插入 [图片1] 标记。
 */
import { useCallback, useRef, useState, type DragEvent as ReactDragEvent } from 'react'
import type { AgentAttachment, PickedFile } from '../../../electron/ipc/channels'
import {
  MAX_ATTACHMENTS,
  filesBridge,
  filesFromFileList,
  looksLikeAbsolutePath,
  unsupportedReason
} from '../../modules/chat/file-support'
import { attachmentKind } from '../input/AttachmentStrip'
import {
  createRefCounters,
  nextAttachmentRef,
  type AttachedFile,
  type RefCounters
} from '../input/inline-ref'
import { agentBridge } from './agent-bridge'

export interface TaskAttachmentControls {
  attachments: AttachedFile[]
  previews: Record<string, string>
  fileNotice: string | null
  setFileNotice: (notice: string | null) => void
  setAttachments: (files: PickedFile[]) => void
  setPreviews: (previews: Record<string, string>) => void
  toAgentAttachments: () => AgentAttachment[]
  /** 返回真正新增的附件（重复/超限/不支持的不会出现在结果里） */
  addFiles: (files: PickedFile[]) => AttachedFile[]
  pickFiles: () => Promise<AttachedFile[]>
  /** 返回被删附件的引用名（没有引用名时为空串） */
  removeAttachment: (path: string) => string
  clearAttachments: () => void
  addFileObjects: (files: File[]) => Promise<AttachedFile[]>
  handleDropFiles: (event: ReactDragEvent<HTMLDivElement>) => Promise<AttachedFile[]>
  /** 粘贴的是本机绝对路径时返回 true（并异步读取文件） */
  handlePasteFiles: (text: string) => boolean
}

export function useTaskAttachments(): TaskAttachmentControls {
  const [attachments, setAttachmentsState] = useState<AttachedFile[]>([])
  const [previews, setPreviewsState] = useState<Record<string, string>>({})
  const [fileNotice, setFileNotice] = useState<string | null>(null)
  /** 与 attachments 同步的即时列表：addFiles 要同步返回新增项，不能等 setState */
  const listRef = useRef<AttachedFile[]>([])
  const countersRef = useRef<RefCounters>(createRefCounters())

  const commit = useCallback((next: AttachedFile[]): void => {
    listRef.current = next
    setAttachmentsState(next)
  }, [])

  const setAttachments = useCallback(
    (files: PickedFile[]): void => {
      commit(files.map((file) => ({ ...file })))
    },
    [commit]
  )

  const setPreviews = useCallback((next: Record<string, string>): void => {
    setPreviewsState(next)
  }, [])

  const toAgentAttachments = useCallback(
    (): AgentAttachment[] =>
      attachments.map((file) => ({
        path: file.path,
        name: file.name,
        kind: attachmentKind(file.name),
        ref: file.ref
      })),
    [attachments]
  )

  const addFiles = useCallback(
    (files: PickedFile[]): AttachedFile[] => {
      if (files.length === 0) return []
      const rejected = files.filter((file) => unsupportedReason(file) !== null)
      if (rejected.length > 0) {
        setFileNotice(`「${rejected[0].name}」这个类型暂时看不了`)
        window.setTimeout(() => setFileNotice(null), 3000)
      }
      const usable = files.filter((file) => unsupportedReason(file) === null)
      if (usable.length === 0) return []
      const merged = [...listRef.current]
      const added: AttachedFile[] = []
      for (const file of usable) {
        if (merged.some((item) => item.path === file.path)) continue
        if (merged.length >= MAX_ATTACHMENTS) {
          setFileNotice(`一次最多带 ${MAX_ATTACHMENTS} 个文件`)
          window.setTimeout(() => setFileNotice(null), 3000)
          break
        }
        const withRef: AttachedFile = {
          ...file,
          ref: nextAttachmentRef(
            file.name,
            attachmentKind(file.name) === 'image' ? 'image' : 'other',
            countersRef.current
          )
        }
        merged.push(withRef)
        added.push(withRef)
      }
      if (added.length > 0) commit(merged)
      for (const file of added) {
        if (attachmentKind(file.name) !== 'image') continue
        void agentBridge()
          ?.previewImage(file.path)
          .then((dataUrl) => {
            if (!dataUrl) return
            setPreviewsState((current) => ({ ...current, [file.path]: dataUrl }))
          })
      }
      return added
    },
    [commit]
  )

  const pickFiles = useCallback(async (): Promise<AttachedFile[]> => {
    const bridge = filesBridge()
    if (!bridge?.pick) {
      setFileNotice('文件选择不可用：请重启应用')
      return []
    }
    const picked = await bridge.pick()
    return addFiles(picked)
  }, [addFiles])

  const removeAttachment = useCallback(
    (path: string): string => {
      const removed = listRef.current.find((item) => item.path === path)
      commit(listRef.current.filter((item) => item.path !== path))
      setPreviewsState((current) => {
        const next = { ...current }
        delete next[path]
        return next
      })
      return removed?.ref ?? ''
    },
    [commit]
  )

  const clearAttachments = useCallback((): void => {
    countersRef.current = createRefCounters()
    commit([])
    setPreviewsState({})
  }, [commit])

  /** 拖入/粘贴的 File 对象 → 附件（有本地路径直接 stat；内存图片落盘后加） */
  const addFileObjects = useCallback(
    async (files: File[]): Promise<AttachedFile[]> => {
      const picked = await filesFromFileList(files)
      if (picked.length === 0) {
        setFileNotice('没有识别到可添加的文件（网页里的文件请先保存到本地）')
        window.setTimeout(() => setFileNotice(null), 3000)
        return []
      }
      return addFiles(picked)
    },
    [addFiles]
  )

  const handleDropFiles = useCallback(
    (event: ReactDragEvent<HTMLDivElement>): Promise<AttachedFile[]> => {
      event.preventDefault()
      const files = Array.from(event.dataTransfer.files)
      if (files.length === 0) return Promise.resolve([])
      return addFileObjects(files)
    },
    [addFileObjects]
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

  return {
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
  }
}
