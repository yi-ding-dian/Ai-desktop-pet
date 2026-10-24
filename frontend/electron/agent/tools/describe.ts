/** 工具调用 → 用户可读的确认卡内容。 */
import { existsSync, readFileSync } from 'node:fs'
import { relative } from 'node:path'
import { resolveMutationTarget } from '../workspace'
import { clip, diffPreview, type ApprovalDescription } from './common'
import { classifyBashCommand } from './danger'

/** 把一次工具调用翻译成用户能看懂的确认卡内容 */
export function describeToolCall(
  toolName: string,
  args: unknown,
  root: string
): ApprovalDescription {
  const a = (args ?? {}) as Record<string, unknown>
  if (toolName === 'bash') {
    const command = String(a.command ?? '')
    const risk = classifyBashCommand(command)
    const notes = [
      risk.dangerous ? `⚠ 危险操作：${risk.labels.join('、')}` : '',
      risk.slow ? '⚠ 递归扫描可能很慢：命令会在超时（最长 10 分钟）后自动终止，建议缩小范围' : ''
    ].filter(Boolean)
    return {
      title: '执行命令',
      command,
      dangerous: risk.dangerous,
      preview: notes.length > 0 ? notes.join(String.fromCharCode(10)) : undefined
    }
  }
  if (toolName === 'write_file') {
    const rawPath = String(a.path ?? '')
    const content = String(a.content ?? '')
    const shown = displayPath(root, rawPath)
    let preview: string
    try {
      const { abs } = resolveMutationTarget(root, rawPath)
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
    return { title: `写入文件 ${shown}`, path: shown, preview: clip(preview, 1600), dangerous: false }
  }
  if (toolName === 'edit_file') {
    const rawPath = String(a.path ?? '')
    const oldText = String(a.old_string ?? '')
    const newText = String(a.new_string ?? '')
    const shown = displayPath(root, rawPath)
    const preview = [
      ...oldText.split(/\r?\n/).slice(0, 10).map((line) => `- ${line}`),
      ...newText.split(/\r?\n/).slice(0, 10).map((line) => `+ ${line}`)
    ].join('\n')
    return { title: `修改文件 ${shown}`, path: shown, preview: clip(preview, 1600), dangerous: false }
  }
  if (toolName === 'delete_path') {
    const shown = displayPath(root, String(a.path ?? ''))
    return {
      title: `删除 ${shown}`,
      path: shown,
      preview: '移到系统回收站（可恢复）',
      dangerous: false
    }
  }
  if (toolName === 'ask_user') {
    return { title: `询问「${String(a.question ?? '')}」`, dangerous: false }
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

/** 展示用路径：工作区内显示相对路径，工作区外显示绝对路径。 */
function displayPath(root: string, rawPath: string): string {
  try {
    const target = resolveMutationTarget(root, rawPath)
    return target.insideWorkspace ? relative(root, target.abs) || '.' : target.abs
  } catch {
    return rawPath
  }
}
