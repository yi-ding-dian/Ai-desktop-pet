/**
 * 执行模式的工具权限策略（2026-10-24）。
 *
 * 纯函数：beforeToolCall 每次调用时按 **当前模式的实时值** 问这里，
 * 因此任务内切换模式从下一次工具调用起立即生效。
 *
 * - 标准：工作区内写/改/删免确认；工作区外确认；bash 一律确认；
 * - 自动：除致命命令外全部放行；
 * - 计划：写/改/删/命令一律拒绝（只读）。
 *
 * 系统目录/盘符根/应用目录等受保护路径 **所有模式永久拒绝**，
 * 复用 safety/path-safety.ts 的 protectedPathReason。
 */
import { relative } from 'node:path'
import { protectedPathReason } from '../safety/path-safety'
import { resolveDeletionTarget, resolveMutationTarget } from './workspace'
import { classifyBashCommand } from './tools/danger'
import type { ExecutionMode } from './types'

export type PolicyDecision =
  | { action: 'allow' }
  | { action: 'confirm'; dangerous: boolean; reason?: string }
  | { action: 'deny'; reason: string }

export interface PolicyInput {
  mode: ExecutionMode
  toolName: string
  args: unknown
  /** 工作区 realpath */
  workspace: string
}

/** 只读/无副作用工具：三模式都放行 */
const READ_TOOLS = new Set([
  'list_files',
  'read_file',
  'search_text',
  'web_search',
  'web_fetch',
  'disk_usage',
  'cleanup_candidates',
  'todo',
  'ask_user'
])

/** 结构化写/删工具：走路径判定（service 也用它判断「首次动手」） */
export const MUTATION_TOOL_NAMES = new Set(['write_file', 'edit_file', 'delete_path'])

const PLAN_DENY =
  '当前是计划模式，只能读取和规划，不能写文件、改文件、删除或执行命令。' +
  '如果用户只是在讨论或提问，正常回答即可，不要为了绕过限制硬凑计划；' +
  '用户明确要动手时，把计划列给用户，等用户点「按此执行」后再执行。'

export function decideToolCall(input: PolicyInput): PolicyDecision {
  const { mode, toolName, args, workspace } = input
  const a = (args ?? {}) as Record<string, unknown>

  if (READ_TOOLS.has(toolName)) return { action: 'allow' }
  if (mode === 'plan') return { action: 'deny', reason: PLAN_DENY }

  if (MUTATION_TOOL_NAMES.has(toolName)) {
    return decideMutation(mode, toolName, String(a.path ?? ''), workspace)
  }

  if (toolName === 'bash') {
    return decideBash(mode, String(a.command ?? ''))
  }

  return { action: 'deny', reason: `未知工具：${toolName}` }
}

function decideMutation(
  mode: ExecutionMode,
  toolName: string,
  rawPath: string,
  workspace: string
): PolicyDecision {
  let target
  try {
    target =
      toolName === 'delete_path'
        ? resolveDeletionTarget(workspace, rawPath)
        : resolveMutationTarget(workspace, rawPath)
  } catch (err) {
    return { action: 'deny', reason: (err as Error).message || '路径无法解析' }
  }

  const protectedReason = protectedPathReason(target.abs)
  if (protectedReason !== null) {
    return { action: 'deny', reason: `受保护路径，不能写入/删除：${protectedReason}` }
  }

  // 删除目标是工作区的祖先：会连工作区一起删掉
  if (toolName === 'delete_path' && isAncestor(target.abs, workspace)) {
    return { action: 'deny', reason: '不能删除包含当前工作区的上级目录' }
  }
  // 删除工作区根本身
  if (toolName === 'delete_path' && target.abs === workspace) {
    return { action: 'deny', reason: '不能删除工作区根目录' }
  }

  if (target.insideWorkspace) return { action: 'allow' }
  if (mode === 'auto') return { action: 'allow' }
  return {
    action: 'confirm',
    dangerous: false,
    reason: '目标在工作区外，确认后才执行'
  }
}

function decideBash(mode: ExecutionMode, command: string): PolicyDecision {
  const risk = classifyBashCommand(command)
  if (mode === 'standard') {
    // 标准模式：命令无法可靠界定范围，一律确认；危险命令标红
    return {
      action: 'confirm',
      dangerous: risk.dangerous,
      reason: risk.dangerous ? `危险命令：${risk.labels.join('、')}` : undefined
    }
  }
  if (risk.dangerous) {
    return {
      action: 'confirm',
      dangerous: true,
      reason: `自动模式仍拦截致命命令：${risk.labels.join('、')}`
    }
  }
  return { action: 'allow' }
}

function isAncestor(candidate: string, target: string): boolean {
  const rel = relative(candidate, target)
  return rel !== '' && !rel.startsWith('..')
}
