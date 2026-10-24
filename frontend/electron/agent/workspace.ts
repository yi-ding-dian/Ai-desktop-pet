/**
 * 工作区授权与路径约束（任务模式的安全底座，2026-10-23）。
 *
 * 规则：
 *  - 工作区只能由用户在原生对话框里选定（绝对路径、已存在、是目录、不是盘符根）；
 *  - 工具拿到的任何路径，最终都必须落在工作区内；
 *  - 目标文件尚不存在时（新建），沿**已存在的父目录**做 realpath，防止经符号链接逃逸。
 */
import { existsSync, lstatSync, realpathSync, statSync } from 'node:fs'
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

/** 目标是否在工作区内（root/abs 都应是 realpath 后的绝对路径） */
export function isInsideRoot(root: string, abs: string): boolean {
  const rel = relative(root, abs)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

export interface MutationTarget {
  /** realpath 后的目标绝对路径（新建文件时已避开符号链接逃逸） */
  abs: string
  /** 是否在工作区内 */
  insideWorkspace: boolean
}

function assertPathText(rawPath: string): string {
  const text = (rawPath ?? '').trim()
  if (!text) throw new WorkspaceError('路径不能为空')
  if (text.includes('\0')) throw new WorkspaceError('路径包含非法字符')
  if (text.startsWith('\\\\')) throw new WorkspaceError('不支持网络路径（UNC）')
  return text
}

/** 解析一个已存在路径（读文件）：允许工作区外绝对路径。 */
export function resolveReadablePath(root: string, rawPath: string): string {
  const text = assertPathText(rawPath)
  const abs = isAbsolute(text) ? resolve(text) : resolve(root, text)
  try {
    return realpathSync(abs)
  } catch {
    throw new WorkspaceError('文件不存在或无法访问')
  }
}

/**
 * 解析写/删目标：支持工作区外绝对路径；目标不存在时沿最近的已存在祖先
 * realpath 后再拼回，避免经符号链接写到别处。
 */
export function resolveMutationTarget(root: string, rawPath: string): MutationTarget {
  const text = assertPathText(rawPath)
  const abs = isAbsolute(text) ? resolve(text) : resolve(root, text)
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
  return { abs: real, insideWorkspace: isInsideRoot(root, real) }
}

/**
 * 解析删除目标：如果目标本身是符号链接，删除的是链接本身，不跟随到链接指向。
 */
export function resolveDeletionTarget(root: string, rawPath: string): MutationTarget {
  const text = assertPathText(rawPath)
  const abs = isAbsolute(text) ? resolve(text) : resolve(root, text)
  try {
    if (lstatSync(abs).isSymbolicLink()) {
      const parent = realpathSync(dirname(abs))
      const linkPath = resolve(parent, basename(abs))
      return { abs: linkPath, insideWorkspace: isInsideRoot(root, linkPath) }
    }
  } catch {
    /* 不存在：走下面的“最近祖先”逻辑（交给工具报不存在） */
  }
  return resolveMutationTarget(root, rawPath)
}
