/** 文件系统工具：列目录 / 读 / 搜 / 写 / 改。 */
import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync
} from 'node:fs'
import { join } from 'node:path'
import { Type } from 'typebox'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import {
  isInsideRoot,
  resolveInsideWorkspace,
  resolveMutationTarget,
  resolveReadablePath
} from '../workspace'
import { extractDocument, isDocumentPath, looksLikePdf } from '../file-extract'
import { matchGlob } from './glob'
import {
  READ_LIMIT_BYTES,
  SKIP_DIRS,
  WRITE_LIMIT_BYTES,
  atomicWrite,
  formatBytes,
  isProbablyBinary,
  ok,
  toRel,
  walkFiles,
  type ToolContext
} from './common'

export function createListFiles(root: string): AgentTool {
  const listFiles: AgentTool = {
    name: 'list_files',
    label: '列出目录',
    description:
      '列出工作区内的目录结构（默认跳过 .git/node_modules/dist 等）。path 相对工作区，depth 1–3。传 pattern 时按文件名/相对路径过滤（支持 **、*、?，如 **/*.ts、*.md），返回扁平匹配列表。',
    parameters: Type.Object({
      path: Type.Optional(Type.String({ description: '相对工作区的目录，默认工作区根' })),
      depth: Type.Optional(Type.Number({ description: '递归层数 1–3，默认 2' })),
      pattern: Type.Optional(
        Type.String({ description: '文件名/相对路径过滤，如 **/*.ts、*.md（可选）' })
      )
    }),
    execute: async (_id, params) => {
      const p = params as { path?: string; depth?: number; pattern?: string }
      const abs = resolveInsideWorkspace(root, p.path && p.path.trim() ? p.path : '.')
      if (!existsSync(abs) || !statSync(abs).isDirectory()) throw new Error('不是目录：' + toRel(root, abs))
      const depth = Math.min(Math.max(Math.trunc(p.depth ?? 2), 1), 3)
      const pattern = (p.pattern ?? '').trim()
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
            if (!pattern) lines.push(`${indent}${entry.name}/`)
            if (level + 1 < depth) walk(itemAbs, level + 1)
          } else if (entry.isFile()) {
            const rel = toRel(root, itemAbs)
            if (pattern && !matchGlob(pattern, rel)) continue
            const size = (() => {
              try {
                return statSync(itemAbs).size
              } catch {
                return 0
              }
            })()
            lines.push(pattern ? `${rel.replace(/\\/g, '/')}  (${formatBytes(size)})` : `${indent}${entry.name}  (${formatBytes(size)})`)
          }
        }
      }
      walk(abs, 0)
      if (pattern) {
        const body = lines.length ? lines.join('\n') : `没有匹配「${pattern}」的文件`
        return ok(`匹配「${pattern}」的文件（${lines.length}）\n${body}`)
      }
      const body = lines.length ? lines.join('\n') : '（空目录）'
      return ok(`${toRel(root, abs)}/\n${body}`)
    }
  }
  return listFiles
}

export function createReadFile(root: string, ctx: ToolContext): AgentTool {
  const readFile: AgentTool = {
    name: 'read_file',
    label: '读取文件',
    description:
      '读取文本文件，返回带行号的内容；PDF / Word / Excel 会抽取正文（PDF 按页分隔，可用 pages 指定页范围）。相对路径按工作区解析，也支持工作区外的绝对路径（只读）。文本可用 offset/limit 按行区间读取。',
    parameters: Type.Object({
      path: Type.String({ description: '相对工作区的路径，或任意绝对路径' }),
      offset: Type.Optional(Type.Number({ description: '起始行（1 起；仅文本文件）' })),
      limit: Type.Optional(Type.Number({ description: '最多读取多少行，默认 400，上限 2000；仅文本文件' })),
      pages: Type.Optional(
        Type.String({ description: 'PDF 页范围，如 "1-20" 或 "3"（仅 PDF 有效）' })
      )
    }),
    execute: async (_id, params) => {
      const p = params as { path: string; offset?: number; limit?: number; pages?: string }
      const abs = resolveReadablePath(root, p.path)
      if (!existsSync(abs)) throw new Error('文件不存在：' + displayOf(root, abs))
      const stat = statSync(abs)
      if (!stat.isFile()) throw new Error('不是文件：' + displayOf(root, abs))

      // PDF / Office：统一交给后端抽取（同一套解析与文案）；文本仍走本地快路径
      if (isDocumentPath(abs) || looksLikePdf(abs)) {
        if (!ctx.callInternal) throw new Error('当前环境不支持读取 PDF/Office 文件')
        const document = await extractDocument(abs, ctx.callInternal, p.pages)
        return ok(`文档「${document.name}」已提取 ${document.chars} 字：\n\n${document.text}`)
      }

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
  return readFile
}

export function createSearchText(root: string): AgentTool {
  const searchText: AgentTool = {
    name: 'search_text',
    label: '搜索文本',
    description:
      '在工作区内按内容搜索（默认不区分大小写），返回 文件:行号:内容。适合定位函数、报错、文档段落。可用 include 只搜某类文件（如 *.ts、src/**/*.md）；不支持正则。',
    parameters: Type.Object({
      query: Type.String({ description: '要搜索的文本（不支持正则）' }),
      path: Type.Optional(Type.String({ description: '限定目录，默认工作区根' })),
      include: Type.Optional(Type.String({ description: '只搜匹配的文件，如 *.ts（可选）' })),
      case_sensitive: Type.Optional(
        Type.Boolean({ description: '是否区分大小写，默认 false' })
      ),
      max_results: Type.Optional(Type.Number({ description: '最多返回条数，默认 50，上限 100' }))
    }),
    execute: async (_id, params) => {
      const p = params as {
        query: string
        path?: string
        include?: string
        case_sensitive?: boolean
        max_results?: number
      }
      const needle = (p.query ?? '').trim()
      if (!needle) throw new Error('搜索内容不能为空')
      const abs = resolveInsideWorkspace(root, p.path && p.path.trim() ? p.path : '.')
      const limit = Math.min(Math.max(Math.trunc(p.max_results ?? 50), 1), 100)
      const include = (p.include ?? '').trim()
      const caseSensitive = p.case_sensitive === true
      const lower = needle.toLowerCase()
      const hits: string[] = []
      let scanned = 0
      for (const file of walkFiles(root, abs, 8)) {
        if (hits.length >= limit) break
        if (include && !matchGlob(include, toRel(root, file))) continue
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
          const hit = caseSensitive
            ? lines[i].includes(needle)
            : lines[i].toLowerCase().includes(lower)
          if (!hit) continue
          hits.push(`${toRel(root, file)}:${i + 1}: ${lines[i].trim().slice(0, 200)}`)
          if (hits.length >= limit) break
        }
      }
      return ok(
        hits.length ? hits.join('\n') : `没有找到「${needle}」（扫描 ${scanned} 个文件）`
      )
    }
  }
  return searchText
}

export function createWriteFile(root: string): AgentTool {
  const writeFile: AgentTool = {
    name: 'write_file',
    label: '写入文件',
    description:
      '新建或整体覆盖一个文本文件。相对路径按工作区解析，也支持工作区外绝对路径；是否需要确认由当前执行模式决定。',
    parameters: Type.Object({
      path: Type.String({ description: '相对工作区的路径，或工作区外绝对路径' }),
      content: Type.String({ description: '完整文件内容' })
    }),
    execute: async (_id, params) => {
      const p = params as { path: string; content: string }
      const target = resolveMutationTarget(root, p.path)
      const size = Buffer.byteLength(p.content ?? '', 'utf8')
      if (size > WRITE_LIMIT_BYTES) {
        throw new Error(`内容过大（${formatBytes(size)}），上限 ${formatBytes(WRITE_LIMIT_BYTES)}`)
      }
      const existed = existsSync(target.abs)
      atomicWrite(target.abs, p.content ?? '')
      return ok(
        `${existed ? '已覆盖' : '已创建'} ${displayOf(root, target.abs)}（${formatBytes(size)}）`
      )
    }
  }
  return writeFile
}

export function createEditFile(root: string): AgentTool {
  const editFile: AgentTool = {
    name: 'edit_file',
    label: '修改文件',
    description:
      '把文件中的 old_string 精确替换成 new_string。old_string 必须在文件中唯一命中（除非 replace_all=true）。相对路径按工作区解析，也支持工作区外绝对路径。',
    parameters: Type.Object({
      path: Type.String({ description: '相对工作区的路径，或工作区外绝对路径' }),
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
      const target = resolveMutationTarget(root, p.path)
      const abs = target.abs
      if (!existsSync(abs)) throw new Error('文件不存在：' + displayOf(root, abs))
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
      return ok(`已修改 ${displayOf(root, abs)}（替换 ${p.replace_all ? count : 1} 处）`)
    }
  }
  return editFile
}

/** 展示路径：工作区内用相对路径，工作区外用绝对路径 */
function displayOf(root: string, abs: string): string {
  return isInsideRoot(root, abs) ? toRel(root, abs) : abs
}
