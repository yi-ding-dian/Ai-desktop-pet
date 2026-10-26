/**
 * 磁盘清理白名单（2026-10-22，主进程；纯文件系统操作，不 import electron）。
 *
 * 与后端 `modules/disk/report.py` 各自独立解析路径：渲染进程/模型只传稳定 key
 * （`user_temp` / `chrome_cache` / ...），**永远不传绝对路径**。主进程这里再按
 * 自己的环境变量重新解析，并做第二次安全校验：
 * - 只允许白名单目录（用户临时目录、浏览器缓存、缩略图缓存）；
 * - 每个路径 realpath 后不得落在受保护目录（Windows/Program Files/…）；
 * - 清理方式是“把目标内容移入同卷暂存目录 → shell.trashItem 整个暂存目录”，
 *   移入回收站可恢复；正在使用/被占用的文件跳过，不做永久删除。
 *
 * 平台差异集中在 resolveCleanTargets 的平台分支内；跨平台共用的只有“怎么统计、
 * 怎么搬”的纯文件系统逻辑。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PLATFORM } from '../platform'
import { protectedPathReason } from './path-safety'

export type CleanKey =
  | 'user_temp'
  | 'chrome_cache'
  | 'edge_cache'
  | 'firefox_cache'
  | 'thumbnails'
  | 'user_cache'
  | 'browser_cache'

export type CleanKind = 'dir_contents' | 'files'

export interface CleanTarget {
  key: CleanKey
  label: string
  kind: CleanKind
  /** 白名单目录/文件（已 realpath；dir_contents 表示清理其内容） */
  paths: string[]
}

export interface CleanTargetsOk {
  ok: true
  targets: CleanTarget[]
}

export interface CleanTargetsError {
  ok: false
  message: string
}

export type CleanTargetsResult = CleanTargetsOk | CleanTargetsError

const LABELS: Record<CleanKey, string> = {
  user_temp: '用户临时文件',
  chrome_cache: 'Chrome 缓存',
  edge_cache: 'Edge 缓存',
  firefox_cache: 'Firefox 缓存',
  thumbnails: '缩略图/图标缓存',
  user_cache: '用户缓存目录',
  browser_cache: '浏览器缓存'
}

const KNOWN_KEYS = new Set<string>(Object.keys(LABELS))

/** 每个目标最多搬多少条（防止 Temp 下几万项卡住主进程） */
const MAX_MOVES_PER_TARGET = 5000
/** 统计单个目录的时间上限 */
const MEASURE_CAP_MS = 2000

interface ResolveOptions {
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
}

function realpathOr(resolved: string): string {
  try {
    return fs.realpathSync.native(resolved)
  } catch {
    return fs.realpathSync(resolved)
  }
}

function isDir(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isDirectory()
  } catch {
    return false
  }
}

function isWithin(child: string, parent: string): boolean {
  const key = (value: string): string =>
    path.normalize(value).replace(/\\/g, '/').toLowerCase()
  const childKey = key(child)
  const parentKey = key(parent)
  if (childKey === parentKey) return true
  const rel = path.relative(parentKey, childKey)
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
}

function normalizeKeys(raw: unknown): { ok: true; keys: CleanKey[] } | CleanTargetsError {
  if (!Array.isArray(raw) || raw.length === 0) {
    return { ok: false, message: '要清理哪些缓存？告诉我需要清的项目。' }
  }
  if (raw.length > 7) {
    return { ok: false, message: '一次最多清理 7 个项目。' }
  }
  const keys: CleanKey[] = []
  for (const item of raw) {
    if (typeof item !== 'string') {
      return { ok: false, message: '清理项目格式不正确。' }
    }
    const key = item.trim()
    if (!key) continue
    if (!KNOWN_KEYS.has(key)) {
      return { ok: false, message: `『${key}』不是可清理的白名单项目。` }
    }
    if (!keys.includes(key as CleanKey)) keys.push(key as CleanKey)
  }
  if (keys.length === 0) {
    return { ok: false, message: '要清理哪些缓存？告诉我需要清的项目。' }
  }
  return { ok: true, keys }
}

function browserCacheDirs(root: string): string[] {
  if (!isDir(root)) return []
  const suffixes = [
    'Cache',
    'Code Cache',
    'GPUCache',
    path.join('Service Worker', 'CacheStorage')
  ]
  const result: string[] = []
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return result
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    for (const suffix of suffixes) {
      const candidate = path.join(root, entry.name, suffix)
      if (isDir(candidate)) result.push(realpathOr(candidate))
    }
  }
  return result
}

function firefoxCacheDirs(root: string): string[] {
  if (!isDir(root)) return []
  const result: string[] = []
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return result
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const candidate = path.join(root, entry.name, 'cache2')
    if (isDir(candidate)) result.push(realpathOr(candidate))
  }
  return result
}

function thumbnailFiles(local: string): string[] {
  const explorer = path.join(local, 'Microsoft', 'Windows', 'Explorer')
  if (!isDir(explorer)) return []
  const base = realpathOr(explorer)
  const result: string[] = []
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(base, { withFileTypes: true })
  } catch {
    return result
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue
    if (!/^(thumbcache_|iconcache_).+\.db$/i.test(entry.name)) continue
    const full = path.join(base, entry.name)
    try {
      if (fs.statSync(full).isFile()) result.push(realpathOr(full))
    } catch {
      // 被占用/权限问题：跳过
    }
  }
  return result
}

function validate(
  key: CleanKey,
  kind: CleanKind,
  paths: string[],
  within?: string
): CleanTargetsError | null {
  if (paths.length === 0) {
    return { ok: false, message: `没有找到${LABELS[key]}（可能没安装或还没用过）。` }
  }
  for (const item of paths) {
    if (kind === 'dir_contents' && path.dirname(item) === item) {
      return { ok: false, message: `为了安全，不能清理磁盘根目录：${item}` }
    }
    const reason = protectedPathReason(item)
    if (reason) {
      return { ok: false, message: `为了安全，不能清理${LABELS[key]}：${reason}` }
    }
    if (within && !isWithin(item, within)) {
      return { ok: false, message: `为了安全，不能清理白名单之外的路径：${item}` }
    }
    try {
      const info = fs.lstatSync(item)
      if (kind === 'files' ? !info.isFile() : !info.isDirectory()) {
        return { ok: false, message: `${LABELS[key]}的路径类型不对，已取消。` }
      }
    } catch (err) {
      return { ok: false, message: `路径现在不可用：${(err as Error).message}` }
    }
  }
  return null
}

function resolveWindows(keys: CleanKey[], env: NodeJS.ProcessEnv): CleanTargetsResult {
  const local = env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
  const temp = env.TEMP || env.TMP || os.tmpdir()
  if (!path.isAbsolute(local) || !path.isAbsolute(temp)) {
    return { ok: false, message: '系统缓存目录异常，已取消清理。' }
  }
  const localReal = isDir(local) ? realpathOr(local) : undefined
  const targets: CleanTarget[] = []

  for (const key of keys) {
    let kind: CleanKind = 'dir_contents'
    let paths: string[] = []
    let within: string | undefined

    if (key === 'user_temp') {
      if (isDir(temp)) {
        const real = realpathOr(temp)
        // TEMP 被改到任意目录时保守拒绝；只认名字是 Temp/tmp 的目录
        const base = path.basename(real).toLowerCase()
        if (base !== 'temp' && base !== 'tmp') {
          return {
            ok: false,
            message: `临时目录不在白名单（目录名不是 Temp/tmp）：${real}`
          }
        }
        paths = [real]
      }
    } else if (key === 'chrome_cache') {
      within = localReal
      paths = browserCacheDirs(path.join(local, 'Google', 'Chrome', 'User Data'))
    } else if (key === 'edge_cache') {
      within = localReal
      paths = browserCacheDirs(path.join(local, 'Microsoft', 'Edge', 'User Data'))
    } else if (key === 'firefox_cache') {
      within = localReal
      paths = firefoxCacheDirs(
        path.join(local, 'Mozilla', 'Firefox', 'Profiles')
      )
    } else if (key === 'thumbnails') {
      kind = 'files'
      const explorer = path.join(local, 'Microsoft', 'Windows', 'Explorer')
      within = isDir(explorer) ? realpathOr(explorer) : undefined
      paths = thumbnailFiles(local)
    } else {
      return { ok: false, message: `当前系统不支持清理 ${LABELS[key]}。` }
    }

    const error = validate(key, kind, paths, within)
    if (error) return error
    targets.push({ key, label: LABELS[key], kind, paths })
  }
  return { ok: true, targets }
}

function resolvePosix(keys: CleanKey[], env: NodeJS.ProcessEnv): CleanTargetsResult {
  const home = env.HOME || os.homedir()
  const cache = env.XDG_CACHE_HOME || path.join(home, '.cache')
  if (!path.isAbsolute(cache)) {
    return { ok: false, message: '系统缓存目录异常，已取消清理。' }
  }
  const targets: CleanTarget[] = []

  for (const key of keys) {
    let paths: string[] = []
    if (key === 'user_cache') {
      if (isDir(cache)) paths = [realpathOr(cache)]
    } else if (key === 'browser_cache') {
      for (const name of ['google-chrome', 'microsoft-edge', 'chromium']) {
        const candidate = path.join(cache, name)
        if (isDir(candidate)) paths.push(realpathOr(candidate))
      }
      const firefox = path.join(cache, 'mozilla', 'firefox')
      if (isDir(firefox)) paths.push(realpathOr(firefox))
    } else {
      return { ok: false, message: `当前系统不支持清理 ${LABELS[key]}。` }
    }

    const error = validate(key, 'dir_contents', paths)
    if (error) return error
    targets.push({ key, label: LABELS[key], kind: 'dir_contents', paths })
  }
  return { ok: true, targets }
}

/** 按 key 解析白名单目标；任何 key 不存在/不安全都整体拒绝（不部分执行）。 */
export function resolveCleanTargets(
  rawKeys: unknown,
  options: ResolveOptions = {}
): CleanTargetsResult {
  const normalized = normalizeKeys(rawKeys)
  if (!normalized.ok) return normalized
  const env = options.env ?? process.env
  const platform = options.platform ?? PLATFORM
  if (platform === 'win32') return resolveWindows(normalized.keys, env)
  if (platform === 'linux') return resolvePosix(normalized.keys, env)
  return { ok: false, message: '这个系统暂时不支持自动清理。' }
}

export interface MeasuredCleanTarget extends CleanTarget {
  size: number
  files: number
  truncated: boolean
}

export interface MeasureResult {
  targets: MeasuredCleanTarget[]
  totalBytes: number
  totalFiles: number
  truncated: boolean
}

function directorySize(
  root: string,
  deadline: number
): { size: number; files: number; truncated: boolean } {
  let size = 0
  let files = 0
  let truncated = false
  const stack = [root]
  while (stack.length > 0) {
    if (Date.now() >= deadline) {
      truncated = true
      break
    }
    const current = stack.pop() as string
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (Date.now() >= deadline) {
        truncated = true
        break
      }
      // 不跟随链接/junction，避免统计到环或系统目录
      if (entry.isSymbolicLink()) continue
      const full = path.join(current, entry.name)
      try {
        if (entry.isDirectory()) {
          stack.push(full)
        } else if (entry.isFile()) {
          size += fs.statSync(full).size
          files += 1
        }
      } catch {
        // 被占用/权限：忽略
      }
    }
  }
  return { size, files, truncated }
}

/** 计算将清理项目的占用（用于确认气泡；带时间上限）。 */
export function measureCleanTargets(
  targets: CleanTarget[],
  budgetMs = MEASURE_CAP_MS
): MeasureResult {
  const deadline = Date.now() + Math.max(200, budgetMs)
  const measured: MeasuredCleanTarget[] = []
  let totalBytes = 0
  let totalFiles = 0
  let truncated = false
  for (const target of targets) {
    let size = 0
    let files = 0
    let cut = false
    for (const item of target.paths) {
      if (target.kind === 'files') {
        try {
          size += fs.statSync(item).size
          files += 1
        } catch {
          continue
        }
      } else {
        const result = directorySize(item, deadline)
        size += result.size
        files += result.files
        cut = cut || result.truncated
      }
    }
    truncated = truncated || cut
    measured.push({ ...target, size, files, truncated: cut })
    totalBytes += size
    totalFiles += files
  }
  return { targets: measured, totalBytes, totalFiles, truncated }
}

export function formatBytes(size: number): string {
  let value = Math.max(0, size)
  for (const unit of ['B', 'KB', 'MB', 'GB', 'TB']) {
    if (value < 1024 || unit === 'TB') {
      return unit === 'B' ? `${Math.round(value)} B` : `${value.toFixed(1)} ${unit}`
    }
    value /= 1024
  }
  return `${value.toFixed(1)} TB`
}

export interface StagedDirectory {
  /** 暂存目录（随后整目录 shell.trashItem） */
  dir: string
  /** 失败时把内容搬回这里 */
  restoreTo: string
  /** 该暂存目录里已搬入的条目数 */
  count: number
  /** 该暂存目录里已搬入的字节数 */
  bytes: number
}

export interface StageResult {
  movedBytes: number
  moved: number
  skipped: number
  capped: boolean
  stages: StagedDirectory[]
}

let stageSeq = 0

function stagePath(parent: string): string {
  stageSeq += 1
  return path.join(
    parent,
    `.pet-clean-${Date.now().toString(36)}-${process.pid}-${stageSeq}`
  )
}

function entrySizeSync(target: string, deadline: number): number {
  try {
    const info = fs.lstatSync(target)
    if (info.isSymbolicLink()) return 0
    if (info.isFile()) return info.size
    if (info.isDirectory()) return directorySize(target, deadline).size
  } catch {
    return 0
  }
  return 0
}

/**
 * 把目标内容搬入同卷暂存目录（不删除）。调用方随后用 shell.trashItem 把暂存目录
 * 放进回收站；失败时调用 restoreStaged 搬回。
 */
export async function stageCleanTarget(target: CleanTarget): Promise<StageResult> {
  const result: StageResult = {
    movedBytes: 0,
    moved: 0,
    skipped: 0,
    capped: false,
    stages: []
  }
  const deadline = Date.now() + MEASURE_CAP_MS

  const moveOne = async (
    from: string,
    to: string,
    restoreTo: string,
    stage: StagedDirectory
  ): Promise<void> => {
    const size = entrySizeSync(from, deadline)
    try {
      await fs.promises.rename(from, to)
      result.moved += 1
      result.movedBytes += size
      stage.count += 1
      stage.bytes += size
    } catch {
      result.skipped += 1
    }
  }

  if (target.kind === 'files') {
    // 按所在目录分组：暂存目录放在同目录（同卷 rename）
    const groups = new Map<string, string[]>()
    for (const item of target.paths) {
      const parent = path.dirname(item)
      const list = groups.get(parent) || []
      list.push(item)
      groups.set(parent, list)
    }
    for (const [parent, files] of groups) {
      const stageDir = stagePath(parent)
      try {
        await fs.promises.mkdir(stageDir)
      } catch {
        result.skipped += files.length
        continue
      }
      const stage: StagedDirectory = {
        dir: stageDir,
        restoreTo: parent,
        count: 0,
        bytes: 0
      }
      for (const item of files) {
        if (result.moved >= MAX_MOVES_PER_TARGET) {
          result.capped = true
          break
        }
        await moveOne(item, path.join(stageDir, path.basename(item)), parent, stage)
      }
      if (stage.count > 0) result.stages.push(stage)
      else await fs.promises.rmdir(stageDir).catch(() => undefined)
    }
    return result
  }

  for (const dir of target.paths) {
    const parent = path.dirname(dir)
    const stageDir = stagePath(parent)
    try {
      await fs.promises.mkdir(stageDir)
    } catch {
      result.skipped += 1
      continue
    }
    const stage: StagedDirectory = {
      dir: stageDir,
      restoreTo: dir,
      count: 0,
      bytes: 0
    }
    let entries: fs.Dirent[]
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true })
    } catch {
      await fs.promises.rmdir(stageDir).catch(() => undefined)
      result.skipped += 1
      continue
    }
    for (const entry of entries) {
      if (result.moved >= MAX_MOVES_PER_TARGET) {
        result.capped = true
        break
      }
      const from = path.join(dir, entry.name)
      await moveOne(from, path.join(stageDir, entry.name), dir, stage)
    }
    if (stage.count > 0) result.stages.push(stage)
    else await fs.promises.rmdir(stageDir).catch(() => undefined)
  }
  return result
}

/** 回收站操作失败时的兜底：把暂存目录里的条目搬回原位（尽力而为）。 */
export async function restoreStaged(stages: StagedDirectory[]): Promise<void> {
  for (const stage of stages) {
    let entries: string[]
    try {
      entries = await fs.promises.readdir(stage.dir)
    } catch {
      continue
    }
    for (const entry of entries) {
      await fs.promises
        .rename(path.join(stage.dir, entry), path.join(stage.restoreTo, entry))
        .catch(() => undefined)
    }
    await fs.promises.rmdir(stage.dir).catch(() => undefined)
  }
}
