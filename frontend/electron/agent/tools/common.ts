/**
 * 任务工具的共用定义与文件系统小工具。
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { basename, dirname, join, relative } from 'node:path'

/** 单文件读取上限（字节） */
export const READ_LIMIT_BYTES = 1024 * 1024
/** 写入 / 编辑上限（字节） */
export const WRITE_LIMIT_BYTES = 512 * 1024
/** 命令行输出上限（字符；超出保留头尾） */

export const SKIP_DIRS = new Set([
  '.git',
  '.svn',
  '.hg',
  '.idea',
  '.vscode',
  'node_modules',
  '.venv',
  'venv',
  '__pycache__',
  '.mypy_cache',
  '.pytest_cache',
  'dist',
  'build',
  'out',
  '.next',
  '.cache'
])

const APPROVAL_TOOLS = new Set(['write_file', 'edit_file', 'bash'])

export interface ToolContext {
  /** 工作区 realpath（已校验） */
  workspace: string
  /** 用户亲手附上的文件原路径（只读放行；数组会被原地追加） */
  extraReadPaths?: string[]
  /** 模型维护的待办清单回调 */
  onTodo: (items: Array<{ text: string; status: 'pending' | 'active' | 'done' }>) => void
}

export function needsApproval(toolName: string): boolean {
  return APPROVAL_TOOLS.has(toolName)
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export function toRel(root: string, abs: string): string {
  const rel = relative(root, abs)
  return rel === '' ? '.' : rel
}

export function isProbablyBinary(buf: Buffer): boolean {
  const probe = buf.subarray(0, 8192)
  return probe.includes(0)
}

/** 工具成功返回值（pi-agent-core 要求 details 字段） */
export function ok(text: string): {
  content: Array<{ type: 'text'; text: string }>
  details: Record<string, never>
} {
  return { content: [{ type: 'text', text }], details: {} }
}

export function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n…（已截断，共 ${text.length} 字符）`
}

/** 简单 diff 预览：生成 -/+ 行（最多 20 行改动，够用户判断即可） */
export function diffPreview(oldText: string, newText: string, oldLabel = '原内容'): string {
  const oldLines = oldText.split(/\r?\n/)
  const newLines = newText.split(/\r?\n/)
  const lines: string[] = []
  const max = Math.max(oldLines.length, newLines.length)
  let shown = 0
  for (let i = 0; i < max && shown < 20; i += 1) {
    const a = oldLines[i]
    const b = newLines[i]
    if (a === b) continue
    if (a !== undefined) {
      lines.push(`- ${a}`)
      shown += 1
    }
    if (b !== undefined) {
      lines.push(`+ ${b}`)
      shown += 1
    }
  }
  if (lines.length === 0) return `${oldLabel}与新内容逐行相同（仅行尾差异）`
  return lines.join('\n')
}

/** 原子写：同目录临时文件 + rename，避免写一半损坏 */
export function atomicWrite(abs: string, content: string): void {
  mkdirSync(dirname(abs), { recursive: true })
  const tmp = join(dirname(abs), `.${basename(abs)}.pet-${process.pid}.tmp`)
  try {
    writeFileSync(tmp, content, 'utf8')
    renameSync(tmp, abs)
  } catch (err) {
    try {
      if (existsSync(tmp)) unlinkSync(tmp)
    } catch {
      /* 清理失败不掩盖原始错误 */
    }
    throw err
  }
}

/** 递归遍历工作区文件（跳过 SKIP_DIRS / 符号链接） */
export function* walkFiles(root: string, start: string, maxDepth: number, depth = 0): Generator<string> {
  let entries
  try {
    entries = readdirSync(start, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const abs = join(start, entry.name)
    if (entry.isSymbolicLink()) continue
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      if (depth < maxDepth) yield* walkFiles(root, abs, maxDepth, depth + 1)
      continue
    }
    if (entry.isFile()) yield abs
  }
}

/** 确认卡内容（不含 id / expiresAt，由 service 补齐） */
export interface ApprovalDescription {
  title: string
  command?: string
  path?: string
  preview?: string
  dangerous: boolean
}
