/**
 * 任务模式的内置工具集合。
 *
 * 边界：
 *  - 所有路径都经 resolveInsideWorkspace 校验，越界直接抛错（模型会收到工具错误）；
 *  - 只读工具（list/read/search）免确认；写/改/执行由 beforeToolCall 弹确认；
 *  - 文本内容有大小上限，避免把上下文一次灌爆。
 *
 * 目录分工：common（共用定义与小工具）/ shell（命令执行）/ disk（只读统计）/
 * filesystem / disk-tools / bash-tool / todo-tool / describe（确认卡）。
 */
import type { AgentTool } from '@earendil-works/pi-agent-core'
import { createBashTool } from './bash-tool'
import { createCleanupCandidates, createDiskUsage } from './disk-tools'
import {
  createEditFile,
  createListFiles,
  createReadFile,
  createSearchText,
  createWriteFile
} from './filesystem'
import { createTodoTool } from './todo-tool'
import type { ToolContext } from './common'

export { needsApproval, type ApprovalDescription, type ToolContext } from './common'
export { killProcessTree, runCommand } from './shell'
export { describeToolCall } from './describe'

export function createTools(ctx: ToolContext): AgentTool[] {
  const root = ctx.workspace
  return [
    createListFiles(root),
    createReadFile(root, ctx),
    createSearchText(root),
    createDiskUsage(root),
    createCleanupCandidates(),
    createWriteFile(root),
    createEditFile(root),
    createBashTool(root),
    createTodoTool(ctx)
  ]
}
