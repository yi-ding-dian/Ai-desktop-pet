/**
 * 附件内联引用（2026-10-27）。
 *
 * 粘贴/选择附件时在输入框光标处插入 [图片1] / [文件1.pdf]，
 * 让用户能在正文里点名某个附件；发送时引用名随附件一起传给模型。
 */
import type { PickedFile } from '../../../electron/ipc/channels'

/** 带引用名的附件（ref 只在渲染侧存在，发送时随 AgentAttachment 一起传） */
export interface AttachedFile extends PickedFile {
  /** 正文引用名：图片1 / 文件1.pdf */
  ref?: string
}

/** 每类附件各自的编号（删除不重排，避免正文里的旧标记指错） */
export interface RefCounters {
  image: number
  file: number
}

export function createRefCounters(): RefCounters {
  return { image: 0, file: 0 }
}

/** 生成下一个引用名：图片1 / 文件2.pdf（扩展名保留原样） */
export function nextAttachmentRef(
  name: string,
  kind: 'image' | 'other',
  counters: RefCounters
): string {
  if (kind === 'image') {
    counters.image += 1
    return `图片${counters.image}`
  }
  counters.file += 1
  const dot = name.lastIndexOf('.')
  const ext = dot > 0 ? name.slice(dot) : ''
  return `文件${counters.file}${ext}`
}

/** 正文里的标记形式 */
export function refToken(ref: string): string {
  return `[${ref}]`
}

/** 在 textarea 光标处插入标记，并把光标移到标记之后 */
export function insertRefToken(
  el: HTMLTextAreaElement | null,
  token: string,
  value: string,
  onChange: (next: string) => void
): void {
  const start = el?.selectionStart ?? value.length
  const end = el?.selectionEnd ?? start
  const next = value.slice(0, start) + token + value.slice(end)
  onChange(next)
  requestAnimationFrame(() => {
    if (!el) return
    el.focus()
    const pos = start + token.length
    el.setSelectionRange(pos, pos)
  })
}

/** 删除附件时把正文里的标记一并去掉（同一个标记出现多次也全部清掉） */
export function removeRefToken(value: string, token: string): string {
  return value.split(token).join('').replace(/[ \t]{2,}/g, ' ')
}
