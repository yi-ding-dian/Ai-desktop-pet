/**
 * 工作区授权与路径约束（任务模式的安全底座，2026-10-23）。
 *
 * 规则：
 *  - 工作区只能由用户在原生对话框里选定（绝对路径、已存在、是目录、不是盘符根）；
 *  - 工具拿到的任何路径，最终都必须落在工作区内；
 *  - 目标文件尚不存在时（新建），沿**已存在的父目录**做 realpath，防止经符号链接逃逸。
 */
import { existsSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, isAbsolute, parse, relative, resolve } from 'node:path'

/** 路径约束失败（文案直接展示给用户，不要塞内部堆栈） */
export class WorkspaceError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WorkspaceError'
  }
}

/** 校验并规范化工作区：返回 realpath（后续所有比较都以它为准） */
export function resolveWorkspace(raw: string): string {
  const text = (raw ?? '').trim()
  if (!text) throw new WorkspaceError('工作区不能为空')
  if (text.startsWith('\\\\')) throw new WorkspaceError('不支持网络路径（UNC）')
  if (!isAbsolute(text)) throw new WorkspaceError('工作区必须是绝对路径')
  let real: string
  try {
    real = realpathSync(text)
  } catch {
    throw new WorkspaceError('工作区不存在或无法访问')
  }
  let isDir = false
  try {
    isDir = statSync(real).isDirectory()
  } catch {
    isDir = false
  }
  if (!isDir) throw new WorkspaceError('工作区必须是文件夹')
  if (parse(real).root === real) throw new WorkspaceError('不能把磁盘根目录当作工作区')
  return real
}

/**
 * 把工具参数里的路径解析为工作区内的绝对路径。
 *
 * 允许相对路径（相对工作区）与绝对路径；越界、UNC、含 NUL 一律拒绝。
 */
export function resolveInsideWorkspace(root: string, rawPath: string): string {
  const text = (rawPath ?? '').trim()
  if (!text) throw new WorkspaceError('路径不能为空')
  if (text.includes('\0')) throw new WorkspaceError('路径包含非法字符')
  if (text.startsWith('\\\\')) throw new WorkspaceError('不支持网络路径（UNC）')

  const abs = isAbsolute(text) ? resolve(text) : resolve(root, text)

  // 目标可能尚不存在（新建文件）：向上找到最近的已存在祖先，逐段拼回
  const missing: string[] = []
  let probe = abs
  while (!existsSync(probe)) {
    const parent = dirname(probe)
    if (parent === probe) break
    missing.unshift(basename(probe))
    probe = parent
  }
  let real: string
  try {
    real = resolve(realpathSync(probe), ...missing)
  } catch {
    throw new WorkspaceError('路径无法解析')
  }

  const rel = relative(root, real)
  if (rel === '') return real
  if (rel.startsWith('..') || isAbsolute(rel)) throw new WorkspaceError('路径超出工作区范围')
  return real
}
