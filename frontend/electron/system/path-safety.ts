/**
 * 本机路径 / URL 安全（2026-10-18，主进程）：打开外链、打开路径、删除路径前的
 * **纯判定**。真正执行在 ipc 域（shell.openExternal / openPath / trashItem）。
 *
 * 为什么主进程还要再判一次：后端 `modules/notebook/paths.py` 已经判过，但渲染
 * 进程/模型工具链不能成为唯一信任边界。这里独立复核：
 * - 只允许 http/https 外链（拒绝 file: / javascript: / 带用户名密码的 URL）；
 * - 路径必须是绝对路径、真实存在、普通文件或文件夹；
 * - 盘符/文件系统根、用户主目录、系统目录、应用目录、AppData 一律拒绝；
 * - 删除一个受保护目录的**祖先**同样拒绝；
 * - 打开文件时拒绝可执行/脚本类扩展名与 POSIX 可执行位（防止“打开”变成“运行”）。
 *
 * 平台约定：本文件**不读 process.platform**——受保护清单同时登记 Windows 与
 * POSIX 的典型目录，在对应平台上不存在的项自然不参与匹配；比较时统一小写，
 * 只会让判定更严格（POSIX 上大小写不同的路径极少见，且最多是拒绝而非放行）。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** 打开结果（渲染侧只关心成功与否 + 可展示原因） */
export interface OpenResult {
  ok: boolean
  message?: string
}

/** 删除路径结果（confirmed=false 表示用户取消/没弹确认） */
export interface DeletePathResult {
  confirmed: boolean
  ok: boolean
  message?: string
}

export interface PathCheckResult {
  /** realpath 后的绝对路径 */
  path: string
  isDir: boolean
}

export interface ExtraProtectedRoot {
  path: string
  /** true = 连目录内部也保护（系统/应用目录）；false = 只保护目录本身与祖先 */
  descendants: boolean
  reason: string
}

/** 打开时拒绝的可执行/脚本扩展名（删除不拦——删除本来就是用户的明确意图） */
const DANGEROUS_EXTENSIONS = new Set([
  '.exe',
  '.com',
  '.bat',
  '.cmd',
  '.msi',
  '.msp',
  '.scr',
  '.pif',
  '.cpl',
  '.jar',
  '.js',
  '.jse',
  '.vbs',
  '.vbe',
  '.wsf',
  '.wsh',
  '.ps1',
  '.psm1',
  '.lnk',
  '.reg',
  '.hta',
  '.msc',
  '.appref-ms',
  '.url',
  '.sh',
  '.bash',
  '.zsh',
  '.fish',
  '.command',
  '.run',
  '.desktop',
  '.appimage',
  '.py',
  '.pyw',
  '.rb',
  '.pl'
])

function realpath(raw: string): string {
  try {
    return fs.realpathSync.native(raw)
  } catch {
    return fs.realpathSync(raw)
  }
}

/** 比较键：统一分隔符 + 小写（跨平台保守判定，不读 process.platform） */
function compareKey(raw: string): string {
  return path.normalize(raw).replace(/\\/g, '/').toLowerCase()
}

function isWithin(childKey: string, parentKey: string): boolean {
  if (childKey === parentKey) return true
  const rel = path.relative(parentKey, childKey)
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
}

/** 校验 http/https 外链（打开外链前的最后一道） */
export function isSafeHttpUrl(raw: unknown): boolean {
  if (typeof raw !== 'string') return false
  const text = raw.trim()
  if (!text || text.length > 2048) return false
  try {
    const url = new URL(text)
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      Boolean(url.hostname) &&
      !url.username &&
      !url.password
    )
  } catch {
    return false
  }
}

/** 归一化并要求路径当前存在；失败抛 Error（message 可直接展示）。 */
export function resolveExistingPath(raw: unknown): PathCheckResult {
  const text = typeof raw === 'string' ? raw.trim().replace(/^["'](.*)["']$/, '$1') : ''
  if (!text) throw new Error('路径不能为空')
  if (!path.isAbsolute(text)) throw new Error('请使用绝对路径')
  const resolved = realpath(text)
  const stat = fs.statSync(resolved)
  if (!stat.isFile() && !stat.isDirectory()) throw new Error('只支持普通文件或文件夹')
  return { path: resolved, isDir: stat.isDirectory() }
}

/** 打开文件时是否属于可执行/脚本类（文件夹永远 false）。 */
export function isDangerousExecutable(target: string, isDir: boolean): boolean {
  if (isDir) return false
  if (DANGEROUS_EXTENSIONS.has(path.extname(target).toLowerCase())) return true
  try {
    const stat = fs.statSync(target)
    // POSIX 可执行位；Windows 上通常为 0，扩展名清单兜住 .exe/.bat 等
    return (stat.mode & 0o111) !== 0
  } catch {
    return false
  }
}

/** 受保护目录清单（extra 由 ipc 域注入 app 的用户数据/缓存目录）。 */
export function protectedRoots(extra: ExtraProtectedRoot[] = []): ExtraProtectedRoot[] {
  const roots: ExtraProtectedRoot[] = []
  const add = (raw: string | undefined, reason: string, descendants: boolean): void => {
    if (!raw) return
    let resolved: string
    try {
      resolved = realpath(raw)
    } catch {
      resolved = path.resolve(raw)
    }
    const key = compareKey(resolved)
    if (!roots.some((root) => compareKey(root.path) === key)) {
      roots.push({ path: resolved, reason, descendants })
    }
  }

  // 文件系统根 / 盘符根（当前工作目录与主目录所在的根都保护）
  add(path.parse(process.cwd()).root, '这是磁盘/文件系统根目录', false)
  add(path.parse(os.homedir()).root, '这是磁盘/文件系统根目录', false)

  // 用户主目录：保护主目录本身与父目录；允许删除里面的具体文件/文件夹
  add(os.homedir(), '这是用户主目录', false)
  add(path.dirname(os.homedir()), '这是用户主目录的上级目录', false)

  // Windows 系统目录（环境变量缺失时自然跳过）
  add(process.env.SystemRoot || process.env.windir, '这是 Windows 系统目录', true)
  add(process.env.ProgramFiles, '这是程序安装目录', true)
  add(process.env['ProgramFiles(x86)'], '这是程序安装目录', true)
  add(process.env.ProgramData, '这是系统数据目录', true)

  // POSIX 系统目录
  for (const raw of [
    '/bin',
    '/sbin',
    '/usr',
    '/etc',
    '/var',
    '/boot',
    '/dev',
    '/proc',
    '/sys',
    '/lib',
    '/lib64'
  ]) {
    add(raw, '这是系统目录', true)
  }

  // 应用自身：程序文件目录与当前工作目录
  add(path.dirname(process.execPath), '这是小兔的程序目录', true)
  add(process.cwd(), '这是当前工作目录', false)

  for (const root of extra) {
    add(root.path, root.reason, root.descendants)
  }
  return roots
}

/** 受保护路径判定：返回中文原因；允许删除返回 null。 */
export function protectedPathReason(
  rawTarget: string,
  extra: ExtraProtectedRoot[] = []
): string | null {
  let target: string
  try {
    target = realpath(rawTarget)
  } catch {
    target = path.resolve(rawTarget)
  }
  const targetKey = compareKey(target)
  for (const root of protectedRoots(extra)) {
    const rootKey = compareKey(root.path)
    if (targetKey === rootKey) return root.reason
    // 目标是受保护目录的祖先：删目标会把它一起带走
    if (isWithin(rootKey, targetKey)) {
      return `删除它会连同受保护的「${root.path}」一起删掉`
    }
    // 系统/应用目录内部也保护
    if (root.descendants && isWithin(targetKey, rootKey)) return root.reason
  }
  return null
}
