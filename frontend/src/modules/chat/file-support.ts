/**
 * 聊天附件的本地快速校验（chat 域，2026-10-18 从 ChatPanel 抽出）。
 *
 * 宠物胶囊与工作模式窗口共用：只按扩展名/常见无扩展名文件做「别把明显不支持
 * 的类型加进列表」的前置判断；真正的正文校验仍由后端 reader 完成。
 * 修改时同步 electron/files/index.ts 的 TEXT_EXTENSIONS 与后端 reader。
 */
import { getPetBridge } from '../../shared/pet-bridge'
import type { PickedFile } from '../../../electron/ipc/channels'

/** 单轮最多附件数（与后端 files.max_per_turn 默认值一致；后端仍会二次校验） */
export const MAX_ATTACHMENTS = 3

/**
 * 前端可快速判定的支持类型（与 electron/files 的筛选、后端 reader 对齐）：
 * 后端仍会做内容级校验；这里只负责"上传时就别把明显不支持的类型加进列表"。
 */
const TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'markdown', 'json', 'jsonl', 'yaml', 'yml', 'toml', 'ini', 'cfg',
  'conf', 'log', 'csv', 'tsv', 'xml', 'html', 'htm', 'css', 'scss', 'less',
  'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'py', 'java', 'kt', 'kts', 'c', 'h',
  'cpp', 'hpp', 'cc', 'cxx', 'cs', 'go', 'rs', 'rb', 'php', 'swift', 'sh',
  'bash', 'zsh', 'ps1', 'bat', 'cmd', 'sql', 'tex', 'vue', 'svelte'
])
const TEXT_BASENAMES = new Set([
  'dockerfile', 'makefile', 'readme', 'license', '.gitignore', '.env', '.editorconfig'
])
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif'])
const WORD_EXTENSIONS = new Set(['docx', 'docm'])
const EXCEL_EXTENSIONS = new Set(['xlsx', 'xlsm'])
const PDF_EXTENSIONS = new Set(['pdf'])

export const SUPPORTED_FILE_HINT =
  '目前支持：文本/代码、图片（PNG/JPEG/WebP/GIF）、PDF、Word（.docx/.docm）、Excel（.xlsx/.xlsm）。'

/** 附件类型（AgentAttachment.kind 的展示口径）：图片走宠物会话，其余走任务模式。 */
export function attachmentKindOf(file: PickedFile): 'image' | 'other' {
  return IMAGE_EXTENSIONS.has(fileExtension(file.name)) ? 'image' : 'other'
}

function fileExtension(name: string): string {
  const index = name.lastIndexOf('.')
  return index >= 0 ? name.slice(index + 1).toLowerCase() : ''
}

/** 返回不支持原因；支持返回 null。只按扩展名/常见无扩展名文件做快速判定。 */
export function unsupportedReason(file: PickedFile): string | null {
  const ext = fileExtension(file.name)
  const base = file.name.toLowerCase()
  if (
    TEXT_EXTENSIONS.has(ext) ||
    TEXT_BASENAMES.has(base) ||
    IMAGE_EXTENSIONS.has(ext) ||
    WORD_EXTENSIONS.has(ext) ||
    EXCEL_EXTENSIONS.has(ext) ||
    PDF_EXTENSIONS.has(ext)
  ) {
    return null
  }
  if (ext === 'doc' || ext === 'xls') {
    return '老式 .doc/.xls 暂时不支持，请另存为 .docx/.xlsx'
  }
  return '这个类型我暂时看不了'
}

/** 宽容取 files 段：旧 preload 没有该段时返回 undefined（按钮给出提示，不崩）。 */
export function filesBridge():
  | {
      pick?: () => Promise<PickedFile[]>
      stat?: (path: string) => Promise<PickedFile | null>
      pathFor?: (file: File) => string
    }
  | undefined {
  try {
    return getPetBridge().files
  } catch {
    return undefined
  }
}

/** 像绝对路径的粘贴内容（Windows 盘符 / UNC / POSIX 绝对路径）；不猜相对路径。 */
export function looksLikeAbsolutePath(text: string): boolean {
  if (!text || text.length > 4096 || text.includes('\n')) return false
  return /^(?:[A-Za-z]:[\\/]|\\\\|\/)/.test(text)
}
