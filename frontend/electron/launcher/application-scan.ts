/**
 * 已安装应用扫描与按名匹配（2026-10-19，主进程 launcher 域）。
 *
 * 只扫描 XDG 标准目录下的 `.desktop`：
 * - `$XDG_DATA_HOME/applications`、`$XDG_DATA_DIRS` 下各根的应用目录、flatpak/snap 导出目录；
 * - 先出现的根优先，同一 desktop id 去重；
 * - 递归深度/文件数/单文件大小都有上限；文件 realpath 必须仍在根内；
 * - `NoDisplay=true`、`Hidden=true`、`Type!=Application` 一律跳过。
 *
 * **匹配结果只用于启动**：主进程自行扫描、自行解析 Exec，渲染进程只传名字，
 * 不能借这条通道执行任意文件。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  execTargetIndex,
  parseDesktopEntry,
  pickLocalized,
  resolveExecTarget,
  splitExec,
  stripFieldCodes
} from './desktop-entry'

export interface ScannedApp {
  /** desktop id（子目录用 '-' 连接） */
  id: string
  /** 本地化显示名 */
  name: string
  genericName: string
  /** Exec 目标的绝对路径；'' = 无法定位 */
  execPath: string
  /** 完整启动参数（含目标本身；字段码已剥离） */
  execArgv: string[]
  /** 去掉字段码后仍有字面参数（直接启动程序本体可能不完整） */
  hasArgs: boolean
  needsTerminal: boolean
  available: boolean
  /** flatpak/snap/env 等 wrapper：单独启动程序本体没有意义 */
  wrapper: boolean
  desktopFile: string
  icon: string
  /** `.desktop` 的 Path= 字段（绝对路径；启动时作为工作目录，空则回退主目录） */
  workingDir: string
}

export interface ApplicationFile {
  id: string
  filePath: string
  content: string
}

export interface ParseOptions {
  locale?: string
  pathEnv: string
  isExecutable: (candidate: string) => boolean
}

const WRAPPER_BASENAMES = new Set(['flatpak', 'snap', 'env', 'xdg-open'])
const MAX_DEPTH = 4
const MAX_FILES = 5000
const MAX_FILE_BYTES = 256 * 1024
const CACHE_TTL_MS = 60_000

interface CacheState {
  apps: ScannedApp[]
  scannedAt: number
}

let cache: CacheState | null = null

/** XDG 应用目录（按优先级排序） */
export function applicationRoots(
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir()
): string[] {
  const dataHome = env.XDG_DATA_HOME || path.join(home, '.local', 'share')
  const dataDirs = (env.XDG_DATA_DIRS || '/usr/local/share:/usr/share')
    .split(':')
    .map((item) => item.trim())
    .filter(Boolean)
  return [
    path.join(dataHome, 'applications'),
    ...dataDirs.map((dir) => path.join(dir, 'applications')),
    path.join(home, '.local', 'share', 'flatpak', 'exports', 'share', 'applications'),
    '/var/lib/flatpak/exports/share/applications',
    '/var/lib/snapd/desktop/applications'
  ]
}

/** 纯解析：把一组 `.desktop` 文件内容转成可启动条目（测试直接调用） */
export function parseApplicationFiles(
  files: ApplicationFile[],
  options: ParseOptions
): ScannedApp[] {
  const result: ScannedApp[] = []
  for (const file of files) {
    const entry = parseDesktopEntry(file.content)
    if (!entry) continue
    if (entry.type !== 'Application' || entry.noDisplay || entry.hidden) continue
    if (!entry.exec.trim()) continue

    const argv = stripFieldCodes(splitExec(entry.exec))
    const targetIndex = execTargetIndex(argv)
    if (targetIndex < 0) continue
    const rawTarget = argv[targetIndex]
    const execPath = resolveExecTarget(
      rawTarget,
      options.pathEnv,
      options.isExecutable
    )
    let available = Boolean(execPath) && options.isExecutable(execPath)

    if (entry.tryExec) {
      const tryPath = resolveExecTarget(
        entry.tryExec,
        options.pathEnv,
        options.isExecutable
      )
      if (!tryPath || !options.isExecutable(tryPath)) available = false
    }

    const base = path.basename(execPath || rawTarget).toLowerCase()
    result.push({
      id: file.id,
      name: pickLocalized(entry.nameMap, entry.name, options.locale) || file.id,
      genericName: pickLocalized(
        entry.genericNameMap,
        entry.genericName,
        options.locale
      ),
      execPath,
      execArgv: argv,
      hasArgs: targetIndex + 1 < argv.length,
      needsTerminal: entry.terminal,
      available,
      wrapper: WRAPPER_BASENAMES.has(base),
      desktopFile: file.filePath,
      icon: entry.icon,
      workingDir: entry.path
    })
  }
  return result
}

/** 递归收集某个根下的 `.desktop` 文件（带上限与根内 realpath 校验） */
function collectDesktopFiles(
  root: string,
  files: ApplicationFile[],
  skippedIds: Set<string>,
  budget: { count: number }
): void {
  let rootReal: string
  try {
    rootReal = fs.realpathSync(root)
  } catch {
    return
  }

  const walk = (dir: string, depth: number): void => {
    if (depth > MAX_DEPTH || budget.count >= MAX_FILES) return
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (budget.count >= MAX_FILES) return
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full, depth + 1)
        continue
      }
      if (!entry.isFile() || !entry.name.endsWith('.desktop')) continue
      let fileReal: string
      let stat: fs.Stats
      try {
        fileReal = fs.realpathSync(full)
        // 符号链接可能把文件指到根外：只接受仍在根内的
        if (fileReal !== rootReal && !fileReal.startsWith(`${rootReal}${path.sep}`)) {
          continue
        }
        stat = fs.statSync(fileReal)
      } catch {
        continue
      }
      if (!stat.isFile() || stat.size > MAX_FILE_BYTES) continue

      const relative = path.relative(root, full)
      const id = relative.replace(/\.desktop$/i, '').split(path.sep).join('-')
      if (skippedIds.has(id)) continue
      skippedIds.add(id)
      budget.count += 1

      try {
        files.push({
          id,
          filePath: fileReal,
          content: fs.readFileSync(fileReal, 'utf8')
        })
      } catch {
        // 读取失败（权限等）直接跳过
      }
    }
  }

  walk(rootReal, 0)
}

export interface ScanOptions {
  refresh?: boolean
  locale?: string
  env?: NodeJS.ProcessEnv
  home?: string
  now?: number
}

/** 扫描已安装应用（60s 缓存；`refresh` 强制重扫） */
export function scanApplications(options: ScanOptions = {}): ScannedApp[] {
  const now = options.now ?? Date.now()
  if (!options.refresh && cache && now - cache.scannedAt < CACHE_TTL_MS) {
    return cache.apps
  }

  const env = options.env ?? process.env
  const files: ApplicationFile[] = []
  const seenIds = new Set<string>()
  const budget = { count: 0 }
  for (const root of applicationRoots(env, options.home)) {
    collectDesktopFiles(root, files, seenIds, budget)
  }

  const apps = parseApplicationFiles(files, {
    locale: options.locale,
    pathEnv: env.PATH || '/usr/local/bin:/usr/bin:/bin',
    isExecutable: isExecutableFile
  })
  cache = { apps, scannedAt: now }
  return apps
}

/** 清空缓存（测试/刷新用） */
export function clearAppCache(): void {
  cache = null
}

function isExecutableFile(candidate: string): boolean {
  try {
    const stat = fs.statSync(candidate)
    if (!stat.isFile()) return false
    if (process.platform === 'win32') {
      return ['.exe', '.com'].includes(path.extname(candidate).toLowerCase())
    }
    return (stat.mode & 0o111) !== 0
  } catch {
    return false
  }
}

export interface AppMatch {
  /** 唯一匹配（可直接启动） */
  match?: ScannedApp
  /** 多个候选（按显示名去重，最多 5 个） */
  candidates: ScannedApp[]
  /** 名字能匹配但程序文件失效（用于给出明确提示） */
  unavailable?: ScannedApp
}

function normalized(value: string): string {
  return String(value || '').trim().toLowerCase()
}

function exactLayer(
  apps: ScannedApp[],
  query: string
): ScannedApp[] {
  const q = normalized(query)
  if (!q) return []
  const idBase = (app: ScannedApp): string => {
    const tail = app.id.split('-').pop() || app.id
    return normalized(tail)
  }
  // 1) 本地化显示名精确
  let hits = apps.filter((app) => normalized(app.name) === q)
  if (hits.length) return hits
  // 2) desktop id 精确
  hits = apps.filter((app) => normalized(app.id) === q)
  if (hits.length) return hits
  // 3) GenericName 精确
  hits = apps.filter((app) => normalized(app.genericName) === q)
  if (hits.length) return hits
  // 4) id 末段（如 org.gnome.gedit → gedit）
  hits = apps.filter((app) => idBase(app) === q)
  if (hits.length) return hits
  // 5) 大小写不敏感已由 normalized 覆盖；这里做唯一前缀/子串
  const partial = apps.filter(
    (app) =>
      normalized(app.name).startsWith(q) ||
      normalized(app.name).includes(q) ||
      normalized(app.id).includes(q)
  )
  return partial
}

function uniqueByName(apps: ScannedApp[]): ScannedApp[] {
  const seen = new Set<string>()
  return apps.filter((app) => {
    const key = normalized(app.name)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/** 按名字匹配已安装应用（本地化 Name → id → GenericName → 唯一前缀/子串） */
export function findApplications(apps: ScannedApp[], query: string): AppMatch {
  const available = apps.filter((app) => app.available)
  const hits = exactLayer(available, query)
  if (hits.length === 1) return { match: hits[0], candidates: [] }
  if (hits.length > 1) {
    return { candidates: uniqueByName(hits).slice(0, 5) }
  }
  const unavailable = exactLayer(
    apps.filter((app) => !app.available),
    query
  )
  if (unavailable.length) {
    return { candidates: [], unavailable: uniqueByName(unavailable)[0] }
  }
  return { candidates: [] }
}
