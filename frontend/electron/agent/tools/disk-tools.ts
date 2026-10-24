/** 磁盘占用与可清理空间两个只读工具。 */
import { existsSync, readdirSync, statSync, statfsSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { Type } from 'typebox'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import { resolveInsideWorkspace } from '../workspace'
import { cleanupTargets, driveRoots, measureDir } from './disk'
import { formatBytes, ok } from './common'

export function createDiskUsage(root: string): AgentTool {
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
  return diskUsage
}

export function createCleanupCandidates(): AgentTool {
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
  return cleanupCandidates
}
