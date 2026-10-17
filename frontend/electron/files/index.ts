/**
 * 文件分析（P1）主进程入口：原生文件选择框 + 粘贴路径校验。
 *
 * 边界（与后端 modules/files 对齐）：
 * - 主进程**只 stat 元信息**，不读正文——正文由本地后端按路径读取并执行
 *   字数/字节/数量限额（渲染进程与主进程都不是限额的权威）；
 * - 路径只在本机流转：不写日志、不进入 LLM 提示词（后端只把文件名交给模型）；
 * - 选择框是用户显式意图；`files:stat` 仅用于"粘贴一个路径"时的存在性校验，
 *   同样不读正文。
 */
import { BrowserWindow, dialog, ipcMain } from 'electron'
import { statSync } from 'node:fs'
import { basename } from 'node:path'
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

/** 注册文件选择相关 IPC（进程内只注册一次；重复调用幂等）。 */
export function initFileSelection(): void {
  if (installed) return
  installed = true

  ipcMain.handle(IPC.FILES_PICK, async (event): Promise<PickedFile[]> => {
    const parent = BrowserWindow.fromWebContents(event.sender)
    const options: Electron.OpenDialogOptions = {
      title: '选择要分析的文件',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: '文本 / 代码', extensions: TEXT_EXTENSIONS },
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
}

/** 退出清理（进程退出本身也会清理；保留对称的销毁入口，便于测试/热重载）。 */
export function destroyFileSelection(): void {
  if (!installed) return
  installed = false
  ipcMain.removeHandler(IPC.FILES_PICK)
  ipcMain.removeHandler(IPC.FILES_STAT)
}
