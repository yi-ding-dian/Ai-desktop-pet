/** 工具调用 → 用户可读的确认卡内容。 */
import { existsSync, readFileSync } from 'node:fs'
import { resolveInsideWorkspace } from '../workspace'
import { clip, diffPreview, toRel, type ApprovalDescription } from './common'

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
  if (toolName === 'web_search') {
    return { title: `联网搜索「${String(a.query ?? '')}」`, dangerous: false }
  }
  if (toolName === 'web_fetch') {
    return { title: `抓取网页 ${String(a.url ?? '')}`, dangerous: false }
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
