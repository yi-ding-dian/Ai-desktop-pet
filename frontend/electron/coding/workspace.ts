/**
 * 编码代理工作区校验（2026-10-23）。
 *
 * 纯函数（除真实路径解析外不碰 Electron），便于单测：
 * - 必须是绝对路径；
 * - 必须是真实存在的目录（解析符号链接后判断）；
 * - 拒绝 UNC/网络路径；
 * - 拒绝盘符/文件系统根；
 * - 拒绝小兔自身的程序/数据/日志目录（由调用方传入，避免本文件依赖 electron）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { protectedPathReason, type ExtraProtectedRoot } from '../system/path-safety'

export type WorkspaceCheck =
  | { ok: true; path: string }
  | { ok: false; message: string }

export interface WorkspaceOptions {
  extraProtectedRoots?: ExtraProtectedRoot[]
  /** 测试注入：替换真实路径解析 */
  realpath?: (target: string) => string
  stat?: (target: string) => fs.Stats
}

export function validateWorkspace(
  raw: string,
  options: WorkspaceOptions = {}
): WorkspaceCheck {
  const text = raw.trim().replace(/^["'](.*)["']$/, '$1')
  if (!text) return { ok: false, message: '工作区不能为空' }
  if (text.includes('\0')) return { ok: false, message: '工作区路径里有非法字符' }
  if (!path.isAbsolute(text)) return { ok: false, message: '工作区必须是绝对路径' }
  if (text.startsWith('\\\\') || text.startsWith('//')) {
    return { ok: false, message: '暂不支持网络路径（UNC）' }
  }

  let resolved: string
  try {
    resolved = (options.realpath ?? fs.realpathSync.native)(text)
  } catch {
    return { ok: false, message: '这个工作区不存在，或者现在打不开' }
  }

  let stat: fs.Stats
  try {
    stat = (options.stat ?? fs.statSync)(resolved)
  } catch {
    return { ok: false, message: '这个工作区不存在，或者现在打不开' }
  }
  if (!stat.isDirectory()) return { ok: false, message: '工作区必须是一个文件夹' }
  if (path.parse(resolved).root === resolved) {
    return { ok: false, message: '不能把整个磁盘根目录交给编码代理' }
  }

  const reason = protectedPathReason(resolved, options.extraProtectedRoots ?? [])
  if (reason) return { ok: false, message: reason }
  return { ok: true, path: resolved }
}
