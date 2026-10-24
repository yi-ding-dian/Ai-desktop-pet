/**
 * 删除文件/目录（2026-10-24）。
 *
 * 语义：**移到系统回收站**（可恢复），不做永久删除。
 * 路径规则与写操作一致：工作区内按模式免确认/确认，工作区外标准确认、自动放行；
 * 受保护系统路径与“包含工作区的上级目录”一律拒绝。
 */
import { existsSync } from 'node:fs'
import { relative } from 'node:path'
import { Type } from 'typebox'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import { protectedPathReason } from '../../system/path-safety'
import { isInsideRoot, resolveDeletionTarget } from '../workspace'
import { ok, type ToolContext } from './common'

export function createDeleteTool(root: string, ctx: ToolContext): AgentTool {
  const deletePath: AgentTool = {
    name: 'delete_path',
    label: '删除',
    description:
      '把文件或目录移到系统回收站（可恢复），不会永久删除。相对路径按工作区解析，也支持工作区外绝对路径；是否需要确认由当前执行模式决定。',
    parameters: Type.Object({
      path: Type.String({ description: '相对工作区的路径，或工作区外绝对路径' })
    }),
    execute: async (_id, params) => {
      const p = params as { path?: string }
      const target = resolveDeletionTarget(root, String(p.path ?? ''))
      if (!existsSync(target.abs)) throw new Error('路径不存在：' + displayPath(root, target.abs))
      const protectedReason = protectedPathReason(target.abs)
      if (protectedReason !== null) {
        throw new Error(`受保护路径，不能删除：${protectedReason}`)
      }
      if (target.abs === root) throw new Error('不能删除工作区根目录')
      const rel = relative(target.abs, root)
      if (rel !== '' && !rel.startsWith('..')) {
        throw new Error('不能删除包含当前工作区的上级目录')
      }
      if (!ctx.trashPath) throw new Error('当前环境不支持移到回收站')
      await ctx.trashPath(target.abs)
      return ok(`已移到回收站：${displayPath(root, target.abs)}`)
    }
  }
  return deletePath
}

function displayPath(root: string, abs: string): string {
  return isInsideRoot(root, abs) ? relative(root, abs) || '.' : abs
}
