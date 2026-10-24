/**
 * 任务模式的内置工具集合。
 *
 * 边界：
 *  - 权限由 agent/policy.ts 按执行模式决定（工作区内/外、bash 风险）；
 *  - 受保护系统路径在策略与工具两层都拒绝；
 *  - 文本内容有大小上限，避免把上下文一次灌爆。
 *
 * 目录分工：common（共用定义与小工具）/ shell（命令执行）/ disk（只读统计）/
 * filesystem / disk-tools / web-tools（联网搜索抓取，走后端内部端点）/
 * bash-tool / todo-tool / ask-user-tool / delete-tool / danger（命令风险）/ describe。
 */
import type { AgentTool } from '@earendil-works/pi-agent-core'
import { createAskUserTool } from './ask-user-tool'
import { createBashTool } from './bash-tool'
import { createCleanupCandidates, createDiskUsage } from './disk-tools'
import { createDeleteTool } from './delete-tool'
import {
  createEditFile,
  createListFiles,
  createReadFile,
  createSearchText,
  createWriteFile
} from './filesystem'
import { createTodoTool } from './todo-tool'
import { createWebFetch, createWebSearch } from './web-tools'
import type { ToolContext } from './common'

export { type ApprovalDescription, type ToolContext } from './common'
export { killProcessTree, runCommand } from './shell'
export { describeToolCall } from './describe'

export function createTools(ctx: ToolContext): AgentTool[] {
  const root = ctx.workspace
  return [
    createListFiles(root),
    createReadFile(root, ctx),
    createSearchText(root),
    createWebSearch(ctx),
    createWebFetch(ctx),
    createDiskUsage(root),
    createCleanupCandidates(),
    createWriteFile(root),
    createEditFile(root),
    createDeleteTool(root, ctx),
    createBashTool(root),
    createTodoTool(ctx),
    createAskUserTool(ctx)
  ]
}
