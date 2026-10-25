/**
 * 任务模式的文档抽取桥（2026-10-25）。
 *
 * PDF / Word / Excel 都是二进制容器，主进程不自己解析——统一调后端内部端点，
 * 与对话附件共用同一套解析、限额和中文错误文案，避免两套实现行为分叉。
 * 图片仍由主进程本地转 base64（更快，也不占后端线程）。
 */
import { closeSync, openSync, readSync } from 'node:fs'
import { extname } from 'node:path'
import type { InternalResult } from './tools/common'

/** 交给后端抽取的文档扩展名（.doc/.xls 也路由过去，好让后端给出"另存为新格式"的提示） */
export const DOCUMENT_EXTENSIONS = new Set([
  'pdf',
  'doc',
  'docx',
  'docm',
  'xls',
  'xlsx',
  'xlsm'
])

export type InternalCaller = (
  path: string,
  body: Record<string, unknown>
) => Promise<InternalResult>

export interface ExtractedDocument {
  name: string
  text: string
  chars: number
}

/** 按扩展名判断是否走后端抽取（不读文件内容，调用方仍需先做路径校验） */
export function isDocumentPath(filePath: string): boolean {
  return DOCUMENT_EXTENSIONS.has(extname(filePath).slice(1).toLowerCase())
}

/** 按文件头识别 PDF（规范允许头部前有少量垃圾字节；不信任扩展名） */
export function looksLikePdf(filePath: string): boolean {
  let fd: number | undefined
  try {
    fd = openSync(filePath, 'r')
    const head = Buffer.alloc(1024)
    const read = readSync(fd, head, 0, head.length, 0)
    return head.subarray(0, read).includes(Buffer.from('%PDF-'))
  } catch {
    return false
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        /* 关闭失败不影响判定 */
      }
    }
  }
}

/**
 * 抽取单个文档的正文。
 *
 * ``pages`` 只对 PDF 有意义（如 "1-20"）；Office 文件忽略该参数。
 * 失败时抛出后端给出的中文原因（已脱敏，可直接展示/回给模型）。
 */
export async function extractDocument(
  filePath: string,
  callInternal: InternalCaller,
  pages?: string
): Promise<ExtractedDocument> {
  const body: Record<string, unknown> = { paths: [filePath] }
  if (pages && pages.trim()) body.pages = pages.trim()
  const result = await callInternal('/internal/files/extract', body)
  if (!result.ok) throw new Error(result.message || '读取文件失败')
  const file = result.files?.[0]
  if (!file || !file.text) throw new Error('没有提取到可以阅读的文字')
  return { name: file.name, text: file.text, chars: file.chars }
}
