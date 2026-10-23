/**
 * 任务模式的 7 个工具（2026-10-23）。
 *
 * 边界：
 *  - 所有路径都经 resolveInsideWorkspace 校验，越界直接抛错（模型会收到工具错误）；
 *  - 只读工具（list/read/search）免确认；写/改/执行由 beforeToolCall 弹确认；
 *  - 文本内容有大小上限，避免把上下文一次灌爆。
 */
import { spawn } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statfsSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { basename, dirname, isAbsolute, join, relative } from 'node:path'
import { Type } from 'typebox'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import { resolveInsideWorkspace } from './workspace'

/** 单文件读取上限（字节） */
const READ_LIMIT_BYTES = 1024 * 1024
/** 写入 / 编辑上限（字节） */
const WRITE_LIMIT_BYTES = 512 * 1024
/** 命令行输出上限（字符；超出保留头尾） */
const BASH_OUTPUT_LIMIT = 200_000
/** 命令默认超时与上限（ms） */
const BASH_DEFAULT_TIMEOUT = 120_000
const BASH_MAX_TIMEOUT = 600_000
/** 目录/搜索遍历跳过的目录名（与常见工程约定一致） */
const SKIP_DIRS = new Set([
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

/** 需要用户确认的工具 */
const APPROVAL_TOOLS = new Set(['write_file', 'edit_file', 'bash'])

/** 递归扫描类命令（只用于确认卡提示「可能很慢」，不阻止执行） */
const SLOW_SCAN_PATTERN = /-Recurse\b|dir\s+\/s\b|du\s+-[a-z]*s\b|find\s+\/\s/i

/** 危险命令启发式（只用于确认卡标红，不阻止执行） */
const DANGEROUS_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /\brm\s+(-[a-z]*[rf][a-z]*\s+)*\/(\s|$)/i, label: '删除根目录' },
  { re: /\bformat\s+[a-z]:/i, label: '格式化磁盘' },
  { re: /\bdiskpart\b/i, label: '磁盘分区工具' },
  { re: /\bshutdown\b|\breboot\b/i, label: '关机/重启' },
  { re: /\bgit\s+reset\s+--hard\b/i, label: '丢弃全部本地修改' },
  { re: /\bgit\s+clean\s+-[a-z]*f/i, label: '删除未跟踪文件' },
  { re: /\bdel\s+\/[sf]\b/i, label: '强制删除' },
  { re: /\b(mkfs|dd\s+if=)/i, label: '写入磁盘' },
  { re: /\bRemove-Item\b.*-Recurse/i, label: '递归删除（PowerShell）' }
]

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

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function toRel(root: string, abs: string): string {
  const rel = relative(root, abs)
  return rel === '' ? '.' : rel
}

function isProbablyBinary(buf: Buffer): boolean {
  const probe = buf.subarray(0, 8192)
  return probe.includes(0)
}

/** 工具成功返回值（pi-agent-core 要求 details 字段） */
function ok(text: string): {
  content: Array<{ type: 'text'; text: string }>
  details: Record<string, never>
} {
  return { content: [{ type: 'text', text }], details: {} }
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n…（已截断，共 ${text.length} 字符）`
}

/** 简单 diff 预览：生成 -/+ 行（最多 20 行改动，够用户判断即可） */
function diffPreview(oldText: string, newText: string, oldLabel = '原内容'): string {
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
function atomicWrite(abs: string, content: string): void {
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

/** 命令行环境白名单：不放任何 Key / Token（含宠物自身的） */
function cleanEnv(): NodeJS.ProcessEnv {
  const keep = [
    'PATH',
    'Path',
    'PATHEXT',
    'SystemRoot',
    'windir',
    'COMSPEC',
    'ComSpec',
    'TEMP',
    'TMP',
    'HOME',
    'USERPROFILE',
    'APPDATA',
    'LOCALAPPDATA',
    'NUMBER_OF_PROCESSORS',
    'OS',
    'PROCESSOR_ARCHITECTURE',
    'LANG',
    'LC_ALL',
    'TERM',
    'SHELL',
    'USER'
  ]
  const env: NodeJS.ProcessEnv = {}
  for (const key of keep) {
    const value = process.env[key]
    if (value !== undefined) env[key] = value
  }
  return env
}

/**
 * 控制台输出解码：先按 UTF-8，出现替换字符再按 GBK 解。
 *
 * 中文 Windows 的 cmd 内建命令（dir 等）按 OEM 代码页输出 GBK 字节，
 * 直接按 UTF-8 解会得到「������ C �еľ���」这类乱码，模型看不懂就会反复重试。
 */
function decodeOutput(buf: Buffer): string {
  if (buf.length === 0) return ''
  const utf8 = new TextDecoder('utf-8').decode(buf)
  if (!utf8.includes('�')) return utf8
  try {
    return new TextDecoder('gbk').decode(buf)
  } catch {
    return utf8
  }
}

/** 回收整棵进程树（Windows 用 taskkill /T，POSIX 用进程组） */
export function killProcessTree(pid: number | undefined): void {
  if (!pid) return
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }).on(
        'error',
        () => undefined
      )
    } catch {
      /* 进程可能已退出 */
    }
    return
  }
  try {
    process.kill(-pid, 'SIGKILL')
  } catch {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      /* 已退出 */
    }
  }
}

interface CommandResult {
  output: string
  code: number | null
  timedOut: boolean
  aborted: boolean
}

/** 执行一条命令：cwd 锁工作区、环境白名单、超时与输出上限、结束回收进程树 */
export function runCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<CommandResult> {
  return new Promise((resolve) => {
    const isWin = process.platform === 'win32'
    // 用 shell:true 交给 Node 处理引号：显式传 ["/d","/s","/c", command] 时
    // libuv 会给带空格的参数整体加引号，cmd 的引号剥离规则会把 `node -e "..."` 这类
    // 命令吃掉（静默无输出）。POSIX 侧 detached 让整组子进程可一次性回收。
    const child = spawn(command, {
      cwd,
      env: cleanEnv(),
      windowsHide: true,
      shell: true,
      detached: !isWin
    })

    // 保留原始字节，结束时再统一解码：中文 Windows 的控制台输出常是 GBK，
    // 边收边按 UTF-8 解会变成乱码，模型读不懂就会不停重试。
    const headChunks: Buffer[] = []
    const tailChunks: Buffer[] = []
    const headLimit = Math.floor(BASH_OUTPUT_LIMIT * 0.75)
    const tailLimit = Math.floor(BASH_OUTPUT_LIMIT * 0.25)
    let headBytes = 0
    let tailBytes = 0
    let totalBytes = 0
    let timedOut = false
    let aborted = false
    let settled = false

    const append = (chunk: Buffer): void => {
      totalBytes += chunk.length
      if (headBytes < headLimit) {
        const room = headLimit - headBytes
        if (chunk.length <= room) {
          headChunks.push(chunk)
          headBytes += chunk.length
          return
        }
        headChunks.push(chunk.subarray(0, room))
        headBytes += room
        chunk = chunk.subarray(room)
      }
      tailChunks.push(chunk)
      tailBytes += chunk.length
      while (tailBytes > tailLimit && tailChunks.length > 1) {
        const dropped = tailChunks.shift()!
        tailBytes -= dropped.length
      }
    }

    child.stdout?.on('data', append)
    child.stderr?.on('data', append)

    const kill = (why: 'timeout' | 'abort'): void => {
      if (why === 'timeout') timedOut = true
      else aborted = true
      killProcessTree(child.pid)
    }

    const timer = setTimeout(() => kill('timeout'), timeoutMs)
    const onAbort = (): void => kill('abort')
    signal?.addEventListener('abort', onAbort, { once: true })

    const finish = (code: number | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      const head = decodeOutput(Buffer.concat(headChunks))
      const kept = headBytes + tailBytes
      const output =
        totalBytes > kept
          ? `${head}\n…（输出过长已截断，共 ${totalBytes} 字节）…\n${decodeOutput(Buffer.concat(tailChunks))}`
          : head
      resolve({ output: output.trim(), code, timedOut, aborted })
    }

    child.on('error', () => finish(null))
    child.on('close', (code) => finish(code))
  })
}

/** 递归遍历工作区文件（跳过 SKIP_DIRS / 符号链接） */
function* walkFiles(root: string, start: string, maxDepth: number, depth = 0): Generator<string> {
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

/** 本机所有可访问的磁盘根（Windows 探测 C:–Z:；POSIX 只有 /） */
function driveRoots(): string[] {
  if (process.platform !== 'win32') return ['/']
  const roots: string[] = []
  for (let code = 67; code <= 90; code += 1) {
    const root = `${String.fromCharCode(code)}:\\`
    try {
      statSync(root)
      roots.push(root)
    } catch {
      /* 不存在的盘符 */
    }
  }
  // C: 一定排在最前（系统盘）
  roots.sort((a, b) => (a === 'C:\\' ? -1 : b === 'C:\\' ? 1 : a.localeCompare(b)))
  return roots
}

/** 递归统计目录大小（不跟随符号链接；条目预算用完即止，结果为下限） */
function measureDir(dir: string, budget: { left: number }, deadline = Infinity): number {
  let total = 0
  const stack = [dir]
  while (stack.length > 0 && budget.left > 0 && Date.now() <= deadline) {
    const current = stack.pop()!
    let entries
    try {
      entries = readdirSync(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (budget.left <= 0) break
      budget.left -= 1
      const abs = join(current, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) stack.push(abs)
      else if (entry.isFile()) {
        try {
          total += statSync(abs).size
        } catch {
          /* 无权限的文件跳过 */
        }
      }
    }
  }
  return total
}


/** 常见可清理位置（只读统计；personal 表示个人文件，只提示不删除） */
interface CleanTarget {
  label: string
  path: string
  kind: 'temp' | 'cache' | 'personal'
}

function cleanupTargets(): CleanTarget[] {
  const home = process.env.USERPROFILE || process.env.HOME || ''
  const local = process.env.LOCALAPPDATA || ''
  const list: CleanTarget[] = []
  const add = (label: string, target: string | undefined, kind: CleanTarget['kind']): void => {
    if (!target) return
    try {
      if (existsSync(target)) list.push({ label, path: target, kind })
    } catch {
      /* 无权限的直接跳过 */
    }
  }
  if (process.platform === 'win32') {
    add('用户临时文件', process.env.TEMP || join(local, 'Temp'), 'temp')
    add('系统临时文件', 'C:\\Windows\\Temp', 'temp')
    add('Windows 更新缓存', 'C:\\Windows\\SoftwareDistribution\\Download', 'cache')
    add('回收站', 'C:\\$Recycle.Bin', 'cache')
    add('npm 缓存', join(local, 'npm-cache'), 'cache')
    add('pip 缓存', join(local, 'pip', 'Cache'), 'cache')
    add('Chrome 缓存', join(local, 'Google', 'Chrome', 'User Data', 'Default', 'Cache'), 'cache')
    add('Edge 缓存', join(local, 'Microsoft', 'Edge', 'User Data', 'Default', 'Cache'), 'cache')
    add('下载文件夹（个人文件）', join(home, 'Downloads'), 'personal')
  } else {
    add('用户缓存', join(home, '.cache'), 'cache')
    add('临时目录', '/tmp', 'temp')
    add('下载文件夹（个人文件）', join(home, 'Downloads'), 'personal')
  }
  return list
}

export function createTools(ctx: ToolContext): AgentTool[] {
  const root = ctx.workspace

  const listFiles: AgentTool = {
    name: 'list_files',
    label: '列出目录',
    description:
      '列出工作区内的目录结构（默认跳过 .git/node_modules/dist 等）。path 相对工作区，depth 1–3。',
    parameters: Type.Object({
      path: Type.Optional(Type.String({ description: '相对工作区的目录，默认工作区根' })),
      depth: Type.Optional(Type.Number({ description: '递归层数 1–3，默认 2' }))
    }),
    execute: async (_id, params) => {
      const p = params as { path?: string; depth?: number }
      const abs = resolveInsideWorkspace(root, p.path && p.path.trim() ? p.path : '.')
      if (!existsSync(abs) || !statSync(abs).isDirectory()) throw new Error('不是目录：' + toRel(root, abs))
      const depth = Math.min(Math.max(Math.trunc(p.depth ?? 2), 1), 3)
      const lines: string[] = []
      const walk = (dir: string, level: number): void => {
        if (lines.length >= 300) return
        let entries
        try {
          entries = readdirSync(dir, { withFileTypes: true })
        } catch {
          return
        }
        const sorted = entries.slice().sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
        for (const entry of sorted) {
          if (lines.length >= 300) return
          const itemAbs = join(dir, entry.name)
          if (entry.isSymbolicLink()) continue
          const indent = '  '.repeat(level)
          if (entry.isDirectory()) {
            if (SKIP_DIRS.has(entry.name)) continue
            lines.push(`${indent}${entry.name}/`)
            if (level + 1 < depth) walk(itemAbs, level + 1)
          } else if (entry.isFile()) {
            const size = (() => {
              try {
                return statSync(itemAbs).size
              } catch {
                return 0
              }
            })()
            lines.push(`${indent}${entry.name}  (${formatBytes(size)})`)
          }
        }
      }
      walk(abs, 0)
      const body = lines.length ? lines.join('\n') : '（空目录）'
      return ok(`${toRel(root, abs)}/\n${body}`)
    }
  }

  /** 读路径：工作区内，或用户亲手附上的文件（只读）；其它一律拒绝 */
  const resolveReadable = (rawPath: string): string => {
    const trimmed = (rawPath ?? '').trim()
    const extra = ctx.extraReadPaths ?? []
    if (isAbsolute(trimmed)) {
      const normalized = trimmed.replace(/\\/g, '/').toLowerCase()
      if (extra.some((item) => item.replace(/\\/g, '/').toLowerCase() === normalized)) {
        return trimmed
      }
    }
    return resolveInsideWorkspace(root, trimmed)
  }

  const readFile: AgentTool = {
    name: 'read_file',
    label: '读取文件',
    description: '读取工作区内的文本文件，返回带行号的内容。可用 offset/limit 按行区间读取。',
    parameters: Type.Object({
      path: Type.String({ description: '相对工作区的文件路径' }),
      offset: Type.Optional(Type.Number({ description: '起始行（1 起）' })),
      limit: Type.Optional(Type.Number({ description: '最多读取多少行，默认 400，上限 2000' }))
    }),
    execute: async (_id, params) => {
      const p = params as { path: string; offset?: number; limit?: number }
      const abs = resolveReadable(p.path)
      if (!existsSync(abs)) throw new Error('文件不存在：' + toRel(root, abs))
      const stat = statSync(abs)
      if (!stat.isFile()) throw new Error('不是文件：' + toRel(root, abs))
      if (stat.size > READ_LIMIT_BYTES) {
        throw new Error(`文件过大（${formatBytes(stat.size)}），上限 ${formatBytes(READ_LIMIT_BYTES)}；请改用 search_text 定位`)
      }
      const buf = readFileSync(abs)
      if (isProbablyBinary(buf)) throw new Error('看起来是二进制文件，无法作为文本读取')
      const lines = buf.toString('utf8').split(/\r?\n/)
      const offset = Math.max(Math.trunc(p.offset ?? 1), 1)
      const limit = Math.min(Math.max(Math.trunc(p.limit ?? 400), 1), 2000)
      const slice = lines.slice(offset - 1, offset - 1 + limit)
      const numbered = slice
        .map((line, i) => `${String(offset + i).padStart(5, ' ')}| ${line}`)
        .join('\n')
      const more =
        offset - 1 + limit < lines.length
          ? `\n…（共 ${lines.length} 行，已显示 ${offset}–${offset + slice.length - 1} 行）`
          : ''
      return ok(numbered + more)
    }
  }

  const searchText: AgentTool = {
    name: 'search_text',
    label: '搜索文本',
    description: '在工作区内按内容搜索（不区分大小写），返回 文件:行号:内容。适合定位函数、报错、文档段落。',
    parameters: Type.Object({
      query: Type.String({ description: '要搜索的文本（不支持正则）' }),
      path: Type.Optional(Type.String({ description: '限定目录，默认工作区根' })),
      max_results: Type.Optional(Type.Number({ description: '最多返回条数，默认 50，上限 100' }))
    }),
    execute: async (_id, params) => {
      const p = params as { query: string; path?: string; max_results?: number }
      const needle = (p.query ?? '').trim()
      if (!needle) throw new Error('搜索内容不能为空')
      const abs = resolveInsideWorkspace(root, p.path && p.path.trim() ? p.path : '.')
      const limit = Math.min(Math.max(Math.trunc(p.max_results ?? 50), 1), 100)
      const lower = needle.toLowerCase()
      const hits: string[] = []
      let scanned = 0
      for (const file of walkFiles(root, abs, 8)) {
        if (hits.length >= limit) break
        scanned += 1
        if (scanned > 5000) break
        let stat
        try {
          stat = statSync(file)
        } catch {
          continue
        }
        if (stat.size > READ_LIMIT_BYTES) continue
        let buf
        try {
          buf = readFileSync(file)
        } catch {
          continue
        }
        if (isProbablyBinary(buf)) continue
        const lines = buf.toString('utf8').split(/\r?\n/)
        for (let i = 0; i < lines.length; i += 1) {
          if (!lines[i].toLowerCase().includes(lower)) continue
          hits.push(`${toRel(root, file)}:${i + 1}: ${lines[i].trim().slice(0, 200)}`)
          if (hits.length >= limit) break
        }
      }
      return ok(
        hits.length ? hits.join('\n') : `没有找到「${needle}」（扫描 ${scanned} 个文件）`
      )
    }
  }

  const writeFile: AgentTool = {
    name: 'write_file',
    label: '写入文件',
    description: '在工作区内新建或整体覆盖一个文本文件。覆盖前会请用户确认。',
    parameters: Type.Object({
      path: Type.String({ description: '相对工作区的文件路径' }),
      content: Type.String({ description: '完整文件内容' })
    }),
    execute: async (_id, params) => {
      const p = params as { path: string; content: string }
      const abs = resolveInsideWorkspace(root, p.path)
      const size = Buffer.byteLength(p.content ?? '', 'utf8')
      if (size > WRITE_LIMIT_BYTES) {
        throw new Error(`内容过大（${formatBytes(size)}），上限 ${formatBytes(WRITE_LIMIT_BYTES)}`)
      }
      const existed = existsSync(abs)
      atomicWrite(abs, p.content ?? '')
      return ok(`${existed ? '已覆盖' : '已创建'} ${toRel(root, abs)}（${formatBytes(size)}）`)
    }
  }

  const editFile: AgentTool = {
    name: 'edit_file',
    label: '修改文件',
    description:
      '把文件中的 old_string 精确替换成 new_string。old_string 必须在文件中唯一命中（除非 replace_all=true）。',
    parameters: Type.Object({
      path: Type.String({ description: '相对工作区的文件路径' }),
      old_string: Type.String({ description: '要替换的原文本（需唯一命中）' }),
      new_string: Type.String({ description: '替换后的文本' }),
      replace_all: Type.Optional(Type.Boolean({ description: '是否替换全部命中，默认 false' }))
    }),
    execute: async (_id, params) => {
      const p = params as {
        path: string
        old_string: string
        new_string: string
        replace_all?: boolean
      }
      const abs = resolveInsideWorkspace(root, p.path)
      if (!existsSync(abs)) throw new Error('文件不存在：' + toRel(root, abs))
      if (!p.old_string) throw new Error('old_string 不能为空')
      const original = readFileSync(abs, 'utf8')
      const count = original.split(p.old_string).length - 1
      if (count === 0) throw new Error('文件里没有找到 old_string，请先读取确认原文')
      if (count > 1 && !p.replace_all) {
        throw new Error(`old_string 命中了 ${count} 处，不唯一；请提供更长的上下文或设置 replace_all=true`)
      }
      const next = p.replace_all
        ? original.split(p.old_string).join(p.new_string)
        : original.replace(p.old_string, p.new_string)
      const size = Buffer.byteLength(next, 'utf8')
      if (size > WRITE_LIMIT_BYTES) {
        throw new Error(`修改后文件过大（${formatBytes(size)}），上限 ${formatBytes(WRITE_LIMIT_BYTES)}`)
      }
      atomicWrite(abs, next)
      return ok(`已修改 ${toRel(root, abs)}（替换 ${p.replace_all ? count : 1} 处）`)
    }
  }

  const diskUsage: AgentTool = {
    name: 'disk_usage',
    label: '磁盘占用',
    description:
      '只读查看磁盘与目录占用（无需确认）。不带 path：列出各磁盘总量/已用/可用；带 path：统计该目录下每个一级子项占多少空间（有扫描上限，不会扫全盘）。',
    parameters: Type.Object({
      path: Type.Optional(Type.String({ description: '要统计的目录；默认只列磁盘容量' }))
    }),
    execute: async (_id, params) => {
      const p = params as { path?: string }
      const lines: string[] = []

      for (const root of driveRoots()) {
        try {
          const stat = statfsSync(root)
          const total = stat.blocks * stat.bsize
          const free = stat.bavail * stat.bsize
          const used = total - free
          const pct = total > 0 ? Math.round((used / total) * 100) : 0
          lines.push(
            `${root}  总 ${formatBytes(total)}  已用 ${formatBytes(used)}（${pct}%）  可用 ${formatBytes(free)}`
          )
        } catch {
          /* 空光驱/无权限的盘符跳过 */
        }
      }

      if (p.path && p.path.trim()) {
        // 目录统计允许工作区外（只读），但仍拒绝 UNC
        const target = p.path.trim().startsWith('\\\\')
          ? null
          : isAbsolute(p.path.trim())
            ? p.path.trim()
            : resolveInsideWorkspace(root, p.path)
        if (!target || !existsSync(target)) throw new Error('目录不存在：' + p.path)
        const children: Array<{ name: string; size: number; partial: boolean }> = []
        let entries
        try {
          entries = readdirSync(target, { withFileTypes: true })
        } catch {
          throw new Error('无法读取目录：' + p.path)
        }
        const dirCount = entries.filter((entry) => entry.isDirectory() && !entry.isSymbolicLink()).length
        // 公平预算：每个一级子目录分到同等条目额度，避免第一个大目录（如 Program Files）
        // 把预算吃光、其余目录全显示 0。同时给一个总时限，防止单次调用拖死任务。
        const perChild = Math.max(2_000, Math.floor(150_000 / Math.max(dirCount, 1)))
        const deadline = Date.now() + 3_000
        for (const entry of entries) {
          const abs = join(target, entry.name)
          if (entry.isSymbolicLink()) continue
          if (entry.isDirectory()) {
            const childBudget = { left: perChild }
            const size = measureDir(abs, childBudget, deadline)
            children.push({
              name: entry.name + '/',
              size,
              partial: childBudget.left <= 0 || Date.now() > deadline
            })
          } else if (entry.isFile()) {
            try {
              children.push({ name: entry.name, size: statSync(abs).size, partial: false })
            } catch {
              /* 读不到大小就跳过 */
            }
          }
        }
        children.sort((a, b) => b.size - a.size)
        const totalSize = children.reduce((sum, item) => sum + item.size, 0)
        lines.push('', `${target}  合计 ≈ ${formatBytes(totalSize)}`)
        for (const child of children.slice(0, 20)) {
          const share = totalSize > 0 ? Math.round((child.size / totalSize) * 100) : 0
          lines.push(
            `  ${child.partial ? '≥' : ' '}${formatBytes(child.size).padStart(9)}  ${String(share).padStart(3)}%  ${child.name}`
          )
        }
        if (children.length > 20) lines.push(`  …还有 ${children.length - 20} 项`)
        if (children.some((child) => child.partial)) {
          lines.push('  （带 ≥ 的是下限：目录太大没扫完；用 path 继续往里看，不要整盘递归）')
        }
      }

      return ok(lines.join('\n') || '没有可读取的磁盘')
    }
  }


  const cleanupCandidates: AgentTool = {
    name: 'cleanup_candidates',
    label: '可清理空间',
    description:
      '只读统计常见可清理位置（临时文件、系统更新缓存、浏览器缓存、回收站、下载文件夹）各占多少空间。只统计，不删除任何东西。',
    parameters: Type.Object({}),
    execute: async () => {
      const deadline = Date.now() + 4_000
      const rows: string[] = []
      let total = 0
      for (const item of cleanupTargets()) {
        if (Date.now() > deadline) {
          rows.push('  …（时间到，剩余位置未统计）')
          break
        }
        const budget = { left: 40_000 }
        const size = measureDir(item.path, budget, deadline)
        const partial = budget.left <= 0 || Date.now() > deadline
        total += size
        const tag = item.kind === 'personal' ? '（个人文件，建议自己确认）' : ''
        rows.push(
          `  ${partial ? '≥' : ' '}${formatBytes(size).padStart(9)}  ${item.label}${tag}
            ${item.path}`
        )
      }
      rows.unshift(`可清理位置合计 ≈ ${formatBytes(total)}（只统计，未删除）`, '')
      return ok(rows.join(String.fromCharCode(10)))
    }
  }

  const bash: AgentTool = {
    name: 'bash',
    label: '执行命令',
    description:
      '在工作区目录下执行一条 shell 命令（如跑测试、构建）。每次执行都会请用户确认；超时默认 120 秒。',
    parameters: Type.Object({
      command: Type.String({ description: '要执行的完整命令' }),
      timeout_ms: Type.Optional(Type.Number({ description: '超时毫秒数，默认 120000，上限 600000' }))
    }),
    execute: async (_id, params, signal, onUpdate) => {
      const p = params as { command: string; timeout_ms?: number }
      const command = (p.command ?? '').trim()
      if (!command) throw new Error('命令不能为空')
      const timeout = Math.min(
        Math.max(Math.trunc(p.timeout_ms ?? BASH_DEFAULT_TIMEOUT), 1_000),
        BASH_MAX_TIMEOUT
      )
      const startedAt = Date.now()
      const progress = setInterval(() => {
        const seconds = Math.round((Date.now() - startedAt) / 1000)
        onUpdate?.({
          content: [{ type: 'text', text: `已运行 ${seconds} 秒…` }],
          details: { seconds }
        })
      }, 1000)
      let result
      try {
        result = await runCommand(command, root, timeout, signal)
      } finally {
        clearInterval(progress)
      }
      if (result.aborted) throw new Error('命令已被中止')
      if (result.timedOut) {
        throw new Error(`命令超时（${Math.round(timeout / 1000)} 秒）已终止\n${result.output.slice(-2000)}`)
      }
      const text = result.output || '（无输出）'
      if (result.code !== 0) {
        throw new Error(`命令退出码 ${result.code}\n${text}`)
      }
      return ok(text)
    }
  }

  const todo: AgentTool = {
    name: 'todo',
    label: '更新待办',
    description:
      '设置当前任务的待办清单（整表替换）。多步任务开始前先拆解，做到哪条就把哪条改成 done。',
    parameters: Type.Object({
      items: Type.Array(
        Type.Object({
          text: Type.String({ description: '待办内容，一句话' }),
          status: Type.String({ description: 'pending / active / done' })
        })
      )
    }),
    execute: async (_id, params) => {
      const p = params as { items: Array<{ text: string; status: string }> }
      const items = (p.items ?? [])
        .filter((item) => item && typeof item.text === 'string')
        .slice(0, 20)
        .map((item) => ({
          text: item.text.slice(0, 200),
          status:
            item.status === 'done' || item.status === 'active'
              ? (item.status as 'done' | 'active')
              : ('pending' as const)
        }))
      ctx.onTodo(items)
      const done = items.filter((item) => item.status === 'done').length
      return ok(`待办已更新：${done}/${items.length} 完成`)
    }
  }

  return [listFiles, readFile, searchText, diskUsage, cleanupCandidates, writeFile, editFile, bash, todo]
}

/** 确认卡内容（不含 id / expiresAt，由 service 补齐） */
export interface ApprovalDescription {
  title: string
  command?: string
  path?: string
  preview?: string
  dangerous: boolean
}

/** 把一次工具调用翻译成用户能看懂的确认卡内容 */
export function describeToolCall(
  toolName: string,
  args: unknown,
  root: string
): ApprovalDescription {
  const a = (args ?? {}) as Record<string, unknown>
  if (toolName === 'bash') {
    const command = String(a.command ?? '')
    const hit = DANGEROUS_PATTERNS.find((item) => item.re.test(command))
    const slow = SLOW_SCAN_PATTERN.test(command)
    const notes = [
      hit ? `⚠ 危险操作：${hit.label}` : '',
      slow ? '⚠ 递归扫描可能很慢：命令会在超时（最长 10 分钟）后自动终止，建议缩小范围' : ''
    ].filter(Boolean)
    return {
      title: '执行命令',
      command,
      dangerous: Boolean(hit),
      preview: notes.length > 0 ? notes.join(String.fromCharCode(10)) : undefined
    }
  }
  if (toolName === 'write_file') {
    const rawPath = String(a.path ?? '')
    const content = String(a.content ?? '')
    let relPath = rawPath
    try {
      relPath = toRel(root, resolveInsideWorkspace(root, rawPath))
    } catch {
      /* 越界路径由工具执行时抛错；确认卡保持原样 */
    }
    let preview: string
    try {
      const abs = resolveInsideWorkspace(root, rawPath)
      if (existsSync(abs)) {
        const old = readFileSync(abs, 'utf8')
        preview = diffPreview(old, content)
      } else {
        preview = content
          .split(/\r?\n/)
          .slice(0, 20)
          .map((line) => `+ ${line}`)
          .join('\n')
      }
    } catch {
      preview = content.slice(0, 800)
    }
    return { title: `写入文件 ${relPath}`, path: relPath, preview: clip(preview, 1600), dangerous: false }
  }
  if (toolName === 'edit_file') {
    const rawPath = String(a.path ?? '')
    const oldText = String(a.old_string ?? '')
    const newText = String(a.new_string ?? '')
    let relPath = rawPath
    try {
      relPath = toRel(root, resolveInsideWorkspace(root, rawPath))
    } catch {
      /* 同上 */
    }
    const preview = [
      ...oldText.split(/\r?\n/).slice(0, 10).map((line) => `- ${line}`),
      ...newText.split(/\r?\n/).slice(0, 10).map((line) => `+ ${line}`)
    ].join('\n')
    return { title: `修改文件 ${relPath}`, path: relPath, preview: clip(preview, 1600), dangerous: false }
  }
  if (toolName === 'list_files') {
    return { title: `列出 ${String(a.path ?? '.')}`, dangerous: false }
  }
  if (toolName === 'read_file') {
    return { title: `读取 ${String(a.path ?? '')}`, dangerous: false }
  }
  if (toolName === 'search_text') {
    return { title: `搜索「${String(a.query ?? '')}」`, dangerous: false }
  }
  if (toolName === 'disk_usage') {
    const target = a.path ? String(a.path) : ''
    return { title: target ? `统计 ${target} 占用` : '查看磁盘容量', dangerous: false }
  }
  if (toolName === 'cleanup_candidates') {
    return { title: '统计可清理空间', dangerous: false }
  }
  if (toolName === 'todo') {
    return { title: '更新待办', dangerous: false }
  }
  return { title: toolName, preview: clip(JSON.stringify(args ?? {}), 800), dangerous: false }
}
