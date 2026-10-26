/**
 * 任务附件（2026-10-26 从 TaskPanel 抽出）。
 *
 * 负责：选择/拖入/粘贴的本地文件与图片、类型过滤、去重、数量上限、
 * 图片预览（主进程读 dataURL）。附件只引用原路径，不复制文件。
 */
import { useCallback, useState, type DragEvent as ReactDragEvent } from 'react'
import type { AgentAttachment, PickedFile } from '../../../electron/ipc/channels'
import {
  MAX_ATTACHMENTS,
  filesBridge,
  filesFromFileList,
  looksLikeAbsolutePath,
  unsupportedReason
} from '../../modules/chat/file-support'
import { attachmentKind } from '../message/AttachmentStrip'
import { agentBridge } from './agent-bridge'

export interface TaskAttachmentControls {
  attachments: PickedFile[]
  previews: Record<string, string>
  fileNotice: string | null
  setFileNotice: (notice: string | null) => void
  setAttachments: (files: PickedFile[]) => void
  setPreviews: (previews: Record<string, string>) => void
  toAgentAttachments: () => AgentAttachment[]
  addFiles: (files: PickedFile[]) => void
  pickFiles: () => Promise<void>
  removeAttachment: (path: string) => void
  clearAttachments: () => void
  addFileObjects: (files: File[]) => Promise<void>
  handleDropFiles: (event: ReactDragEvent<HTMLDivElement>) => void
  /** 粘贴的是本机绝对路径时返回 true（并异步读取文件） */
  handlePasteFiles: (text: string) => boolean
}

export function useTaskAttachments(): TaskAttachmentControls {
  const [attachments, setAttachmentsState] = useState<PickedFile[]>([])
  const [previews, setPreviewsState] = useState<Record<string, string>>({})
  const [fileNotice, setFileNotice] = useState<string | null>(null)

  const setAttachments = useCallback((files: PickedFile[]): void => {
    setAttachmentsState(files)
  }, [])

  const setPreviews = useCallback((next: Record<string, string>): void => {
    setPreviewsState(next)
  }, [])

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
    setAttachmentsState((current) => {
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
          setPreviewsState((current) => ({ ...current, [file.path]: dataUrl }))
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
    setAttachmentsState((current) => current.filter((item) => item.path !== path))
    setPreviewsState((current) => {
      const next = { ...current }
      delete next[path]
      return next
    })
  }, [])

  const clearAttachments = useCallback((): void => {
    setAttachmentsState([])
    setPreviewsState({})
  }, [])

  /** 拖入/粘贴的 File 对象 → 附件（有本地路径直接 stat；内存图片落盘后加） */
  const addFileObjects = useCallback(
    async (files: File[]): Promise<void> => {
      const picked = await filesFromFileList(files)
      if (picked.length === 0) {
        setFileNotice('没有识别到可添加的文件（网页里的文件请先保存到本地）')
        window.setTimeout(() => setFileNotice(null), 3000)
        return
      }
      addFiles(picked)
    },
    [addFiles]
  )

  const handleDropFiles = useCallback(
    (event: ReactDragEvent<HTMLDivElement>): void => {
      event.preventDefault()
      const files = Array.from(event.dataTransfer.files)
      if (files.length === 0) return
      void addFileObjects(files)
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
