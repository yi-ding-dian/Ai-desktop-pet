/** 磁盘/目录占用的只读统计。 */
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** 本机所有可访问的磁盘根（Windows 探测 C:–Z:；POSIX 只有 /） */
export function driveRoots(): string[] {
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
export function measureDir(dir: string, budget: { left: number }, deadline = Infinity): number {
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
export interface CleanTarget {
  label: string
  path: string
  kind: 'temp' | 'cache' | 'personal'
}

export function cleanupTargets(): CleanTarget[] {
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
