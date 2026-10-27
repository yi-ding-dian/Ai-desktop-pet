/** 任务附件：过滤与拼进本轮消息（图片给模型看，文本/文档内联）。 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { extname } from 'node:path'
import type { ImageContent } from '@earendil-works/pi-ai'
import type { AgentAttachment } from './types'
import {
  extractDocument,
  isDocumentPath,
  looksLikePdf,
  type InternalCaller
} from './file-extract'
import {
  IMAGE_MIME,
  MAX_ATTACHMENTS,
  MAX_IMAGE_BYTES,
  MAX_INLINE_TEXT,
  clipText
} from './session'

/** 过滤附件：存在、是文件、最多 3 个 */
export function normalizeAttachments(
  list: AgentAttachment[] | undefined
): AgentAttachment[] {
  if (!Array.isArray(list)) return []
  const result: AgentAttachment[] = []
  for (const item of list.slice(0, MAX_ATTACHMENTS)) {
    if (!item || typeof item.path !== 'string') continue
    try {
      if (!existsSync(item.path) || !statSync(item.path).isFile()) continue
    } catch {
      continue
    }
    result.push({
      path: item.path,
      name: item.name || item.path.split(/[\\/]/).pop() || item.path,
      kind: item.kind === 'image' ? 'image' : item.kind === 'text' ? 'text' : 'other',
      // 引用名只用于提示词里的对应关系，限长避免渲染侧塞进超长文本
      ref: typeof item.ref === 'string' && item.ref.trim() ? item.ref.trim().slice(0, 80) : undefined
    })
  }
  return result
}

/**
 * 把附件拼进这一轮消息：
 *  - 图片 → 作为 image content 直接给模型看（不复制文件）
 *  - PDF / Word / Excel → 调后端内部端点抽取正文（与对话附件同一套解析）
 *  - 文本/代码 → 读取内容内联（单文件 2 万字上限）
 *  - 其它 → 只给路径（模型读不了）
 *
 * ``callInternal`` 由主进程注入；离线自测没有后端时，文档走"读不了"的提示。
 */
export async function buildPrompt(
  text: string,
  attachments: AgentAttachment[],
  callInternal?: InternalCaller
): Promise<{ text: string; images: ImageContent[] }> {
  const parts: string[] = [text]
  const images: ImageContent[] = []
  /** 正文引用名（图片1 / 文件1.pdf）；没有引用名时退回文件名 */
  const label = (item: AgentAttachment): string =>
    item.ref ? `[${item.ref}]` : item.name
  const attachTag = (item: AgentAttachment): string =>
    `引用="${label(item)}" 名称="${item.name}" 路径="${item.path}"`
  /** 成功随消息发送的图片序号（正文里的 [图片N] 靠它和 image part 对上） */
  let imageIndex = 0
  for (const item of attachments) {
    const ext = extname(item.path).slice(1).toLowerCase()
    try {
      const stat = statSync(item.path)
      if (IMAGE_MIME[ext]) {
        if (stat.size > MAX_IMAGE_BYTES) {
          parts.push(`（图片 ${label(item)}（${item.name}）超过 8MB，未随消息发送）`)
          continue
        }
        images.push({
          type: 'image',
          data: readFileSync(item.path).toString('base64'),
          mimeType: IMAGE_MIME[ext]
        })
        imageIndex += 1
        parts.push(
          `（正文中的 ${label(item)} 指本消息随附的第 ${imageIndex} 张图片，原文件：${item.name}）`
        )
        continue
      }
      if (isDocumentPath(item.path) || looksLikePdf(item.path)) {
        if (!callInternal) {
          parts.push(`（附件 ${label(item)} 是 PDF/Office 文档，当前环境读不了内容）`)
          continue
        }
        try {
          const document = await extractDocument(item.path, callInternal)
          parts.push(
            `<附件 ${attachTag(item)}>\n${clipText(document.text, MAX_INLINE_TEXT)}\n</附件>`
          )
        } catch (err) {
          parts.push(`（附件 ${label(item)} 读取失败：${(err as Error).message}）`)
        }
        continue
      }
      if (stat.size > MAX_INLINE_TEXT * 4) {
        parts.push(`（附件 ${label(item)} 太大，未内联；需要时用 read_file 分段读取）`)
        continue
      }
      const buf = readFileSync(item.path)
      if (buf.subarray(0, 8192).includes(0)) {
        parts.push(`（附件 ${label(item)} 是二进制文件，读不了内容）`)
        continue
      }
      const content = buf.toString('utf8')
      parts.push(
        `<附件 ${attachTag(item)}>\n${clipText(content, MAX_INLINE_TEXT)}\n</附件>`
      )
    } catch (err) {
      parts.push(`（附件 ${label(item)} 读取失败：${(err as Error).message}）`)
    }
  }
  return { text: parts.join('\n\n'), images }
}
