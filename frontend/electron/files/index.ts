/**
 * 文件分析（P1）主进程入口：原生文件选择框 + 粘贴路径校验。
 *
 * 边界（与后端 modules/files 对齐）：
 * - 主进程**只 stat 元信息**，不读正文——正文由本地后端按路径读取并执行
 *   字数/字节/数量限额（渲染进程与主进程都不是限额的权威）；
 * - 路径只在本机流转：不写日志、不进入 LLM 提示词（后端只把文件名交给模型）；
 * - 选择框是用户显式意图；`files:stat` 仅用于"粘贴一个路径"时的存在性校验，
 *   同样不读正文。
 * - 选择框筛选项包含文本/代码、.docx、.xlsx/.xlsm、图片；拖拽/粘贴路径不受筛选限制，
 *   最终格式由后端 reader 判定（Word/Excel 正文由后端提取，主进程不解析）。
 */
import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { basename, isAbsolute, join, relative, resolve } from 'node:path'
import { IPC, type PickedFile } from '../ipc/channels'

/** 选择框里的常见文本/代码扩展名（仍允许"所有文件"，由后端做内容判定） */
const TEXT_EXTENSIONS = [
  'txt',
  'md',
  'markdown',
  'json',
  'jsonl',
  'yaml',
  'yml',
  'toml',
  'ini',
  'cfg',
  'conf',
  'log',
  'csv',
  'tsv',
  'xml',
  'html',
  'css',
  'scss',
  'less',
  'js',
  'jsx',
  'ts',
  'tsx',
  'py',
  'java',
  'kt',
  'c',
  'h',
  'cpp',
  'hpp',
  'cs',
  'go',
  'rs',
  'rb',
  'php',
  'swift',
  'sh',
  'bash',
  'zsh',
  'ps1',
  'bat',
  'cmd',
  'sql',
  'tex',
  'vue',
  'svelte'
]

/** 粘贴图片落盘目录（userData 下；任务/对话删除时不保证立刻清理，靠 TTL） */
const PASTED_IMAGE_DIR = 'pasted-images'
/** 粘贴图片保留时长（7 天）：会话记录不存路径，只能按时间回收 */
const PASTED_IMAGE_TTL_MS = 7 * 24 * 60 * 60 * 1000
/** 单张粘贴图片字节上限（下游图片附件上限更小，这里只挡离谱的大文件） */
const MAX_PASTED_IMAGE_BYTES = 20 * 1024 * 1024

let installed = false

/** 路径 → PickedFile（非普通文件/不存在 → null）；不读正文。 */
function toPickedFile(rawPath: unknown): PickedFile | null {
  if (typeof rawPath !== 'string') return null
  const path = rawPath.trim()
  if (!path) return null
  try {
    const stat = statSync(path)
    if (!stat.isFile()) return null
    return { path, name: basename(path), size: stat.size }
  } catch {
    return null
  }
}

function pastedImageDir(): string {
  return join(app.getPath('userData'), PASTED_IMAGE_DIR)
}

/** 按文件头判断图片格式；不信任渲染层传的 MIME */
function imageExtension(bytes: Buffer): 'png' | 'jpg' | 'gif' | 'webp' | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes.subarray(1, 4).toString('latin1') === 'PNG') {
    return 'png'
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'jpg'
  }
  if (bytes.length >= 6 && bytes.subarray(0, 3).toString('latin1') === 'GIF') return 'gif'
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString('latin1') === 'RIFF' &&
    bytes.subarray(8, 12).toString('latin1') === 'WEBP'
  ) {
    return 'webp'
  }
  return null
}

function pasteStamp(): string {
  const date = new Date()
  const pad = (value: number): string => String(value).padStart(2, '0')
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-` +
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  )
}

/** 清理过期的粘贴图片（目录不存在视为正常） */
function prunePastedImages(dir: string): void {
  try {
    const now = Date.now()
    for (const name of readdirSync(dir)) {
      const file = join(dir, name)
      try {
        if (now - statSync(file).mtimeMs > PASTED_IMAGE_TTL_MS) unlinkSync(file)
      } catch {
        /* 单个文件删不掉：下次再试 */
      }
    }
  } catch {
    /* 目录还没创建 */
  }
}

function bufferFrom(raw: unknown): Buffer | null {
  if (raw instanceof ArrayBuffer) return Buffer.from(raw)
  if (ArrayBuffer.isView(raw)) return Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength)
  return null
}

/**
 * 删除任务引用过的粘贴图片（只删 `pasted-images/` 里的，用户原文件绝不动）。
 *
 * 由 agent 删除任务时调用；调用方需先排除仍被其他任务引用的路径。
 */
export function deletePastedImages(paths: readonly string[]): void {
  const dir = pastedImageDir()
  for (const raw of paths) {
    if (!raw) continue
    const abs = resolve(raw)
    const rel = relative(dir, abs)
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) continue
    try {
      unlinkSync(abs)
    } catch {
      /* 已不存在 */
    }
  }
}

/** 注册文件选择相关 IPC（进程内只注册一次；重复调用幂等）。 */
export function initFileSelection(): void {
  if (installed) return
  installed = true
  prunePastedImages(pastedImageDir())

  ipcMain.handle(IPC.FILES_PICK, async (event): Promise<PickedFile[]> => {
    const parent = BrowserWindow.fromWebContents(event.sender)
    const options: Electron.OpenDialogOptions = {
      title: '选择要分析的文件',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: '文本 / 代码', extensions: TEXT_EXTENSIONS },
        { name: 'PDF 文档（.pdf）', extensions: ['pdf'] },
        { name: 'Word 文档（.docx）', extensions: ['docx'] },
        { name: 'Excel 表格（.xlsx/.xlsm）', extensions: ['xlsx', 'xlsm'] },
        { name: '图片（PNG/JPEG/WebP/GIF）', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] },
        { name: '所有文件', extensions: ['*'] }
      ]
    }
    const result = parent
      ? await dialog.showOpenDialog(parent, options)
      : await dialog.showOpenDialog(options)
    if (result.canceled) return []
    return result.filePaths
      .map((filePath) => toPickedFile(filePath))
      .filter((file): file is PickedFile => file !== null)
  })

  ipcMain.handle(IPC.FILES_STAT, (_event, rawPath: unknown): PickedFile | null => {
    return toPickedFile(rawPath)
  })

  // 剪贴板图片（截图/网页复制）没有本地路径：渲染层把字节交过来，主进程落盘
  ipcMain.handle(IPC.FILES_SAVE_PASTED_IMAGE, (_event, payload: unknown): PickedFile | null => {
    try {
      const data = (payload as { data?: unknown } | null)?.data
      const bytes = bufferFrom(data)
      if (!bytes || bytes.length === 0 || bytes.length > MAX_PASTED_IMAGE_BYTES) return null
      const ext = imageExtension(bytes)
      if (!ext) return null
      const dir = pastedImageDir()
      mkdirSync(dir, { recursive: true })
      prunePastedImages(dir)
      const name = `粘贴图片-${pasteStamp()}-${randomBytes(3).toString('hex')}.${ext}`
      const file = join(dir, name)
      writeFileSync(file, bytes)
      return toPickedFile(file)
    } catch {
      return null
    }
  })
}

/** 退出清理（进程退出本身也会清理；保留对称的销毁入口，便于测试/热重载）。 */
export function destroyFileSelection(): void {
  if (!installed) return
  installed = false
  ipcMain.removeHandler(IPC.FILES_PICK)
  ipcMain.removeHandler(IPC.FILES_STAT)
  ipcMain.removeHandler(IPC.FILES_SAVE_PASTED_IMAGE)
}
