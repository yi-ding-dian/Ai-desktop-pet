/**
 * 已安装应用扫描：Windows 开始菜单（2026-10-22，主进程 launcher 域）。
 *
 * 与 Linux 侧的 `.desktop` 扫描（application-scan.ts）并列：
 * - 只扫描开始菜单两个 Programs 根（当前用户 `%APPDATA%` 优先，然后 `%ProgramData%`）；
 * - 解析 `.lnk`（MS-SHLLINK）拿目标/参数/工作目录/图标，**不经过 shell**；
 * - 目标必须是绝对路径、普通 `.exe` / `.com`；开始菜单里的失效快捷方式也保留
 *   （`available=false`，供"程序找不到了"提示）；
 * - 递归深度/文件数/单文件大小都有上限；符号链接/junction 解析后必须仍在根内。
 *
 * 匹配仍交给 application-scan 的 `findApplications`：本模块只负责把 `.lnk`
 * 变成同样的 `ScannedApp`，渲染进程依旧只能传名字，不能借这条通道执行任意文件。
 */

import fs from 'node:fs'
import path from 'node:path'
import type { ScannedApp } from './application-scan'

/**
 * 快捷方式里的目标是 Windows 路径，与运行测试的主机无关：
 * 解析/拼接一律用 `path.win32`，否则 Linux 上跑本文件的测试会得到错误结果。
 */
const winPath = path.win32

/** 解析出的快捷方式目标 */
export interface ShellLinkInfo {
  /** 目标绝对路径（已展开 `%VAR%`） */
  target: string
  args: string[]
  workingDir: string
  icon: string
}

const HEADER_SIZE = 0x4c
/** `{00021401-0000-0000-C000-000000000046}` 的字节序形式 */
const SHELL_LINK_CLSID = Buffer.from([
  0x01, 0x14, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0xc0, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x46
])

const HAS_TARGET_ID_LIST = 0x1
const HAS_LINK_INFO = 0x2
const HAS_NAME = 0x4
const HAS_RELATIVE_PATH = 0x8
const HAS_WORKING_DIR = 0x10
const HAS_ARGUMENTS = 0x20
const HAS_ICON_LOCATION = 0x40
const IS_UNICODE = 0x80
const HAS_EXP_STRING = 0x200
/** ExtraData: EnvironmentVariableDataBlock（存 `%windir%\...` 这类目标） */
const ENVIRONMENT_BLOCK_SIGNATURE = 0xa0000001
const ENVIRONMENT_BLOCK_SIZE = 0x314

const MAX_DEPTH = 6
const MAX_FILES = 5000
const MAX_FILE_BYTES = 256 * 1024
const CACHE_TTL_MS = 60_000

/**
 * 只是命令宿主/安装器的入口：开始菜单里真实存在（如 "Node.js command prompt"
 * 指向 cmd.exe），但「启动程序本体」对它们没有意义，安全校验也会拒绝。
 */
const WRAPPER_BASENAMES = new Set([
  'cmd.exe',
  'powershell.exe',
  'pwsh.exe',
  'msiexec.exe',
  'wscript.exe',
  'cscript.exe',
  'mshta.exe',
  'rundll32.exe',
  'explorer.exe'
])

let gbkDecoder: InstanceType<typeof TextDecoder> | null | undefined

/** ANSI 字符串：纯 ASCII 直接按字节；非 ASCII 按系统代码页（中文 Windows = GBK）尽力解码 */
function decodeAnsi(bytes: Buffer): string {
  if (!bytes.length) return ''
  for (const byte of bytes) {
    if (byte >= 0x80) {
      if (gbkDecoder === undefined) {
        try {
          gbkDecoder = new TextDecoder('gbk')
        } catch {
          gbkDecoder = null
        }
      }
      return gbkDecoder ? gbkDecoder.decode(bytes) : bytes.toString('latin1')
    }
  }
  return bytes.toString('latin1')
}

/** 展开 `%NAME%`（环境变量名大小写不敏感） */
export function expandWindowsEnv(
  value: string,
  env: NodeJS.ProcessEnv = process.env
): string {
  if (!value || !value.includes('%')) return value
  return value.replace(/%([^%]+)%/g, (whole, name: string) => {
    const key = Object.keys(env).find(
      (candidate) => candidate.toLowerCase() === name.toLowerCase()
    )
    const replacement = key ? env[key] : undefined
    return replacement ? replacement : whole
  })
}

class Reader {
  readonly buffer: Buffer
  offset: number

  constructor(buffer: Buffer, offset = 0) {
    this.buffer = buffer
    this.offset = offset
  }

  get remaining(): number {
    return this.buffer.length - this.offset
  }

  u16(): number {
    if (this.remaining < 2) throw new RangeError('short buffer')
    const value = this.buffer.readUInt16LE(this.offset)
    this.offset += 2
    return value
  }

  u32(): number {
    if (this.remaining < 4) throw new RangeError('short buffer')
    const value = this.buffer.readUInt32LE(this.offset)
    this.offset += 4
    return value
  }

  skip(count: number): void {
    if (count < 0 || this.offset + count > this.buffer.length) {
      throw new RangeError('short buffer')
    }
    this.offset += count
  }
}

/** 读 LinkInfo 里的 null 结尾字符串 */
function readCStringAt(buffer: Buffer, offset: number, unicode: boolean): string {
  if (offset <= 0 || offset >= buffer.length) return ''
  if (unicode) {
    let end = offset
    while (end + 1 < buffer.length && !(buffer[end] === 0 && buffer[end + 1] === 0)) {
      end += 2
    }
    return buffer.toString('utf16le', offset, end)
  }
  const end = buffer.indexOf(0, offset)
  if (end < 0) return ''
  return decodeAnsi(buffer.subarray(offset, end))
}

/**
 * 读 LinkInfo 的本地路径（LocalBasePath + CommonPathSuffix）。
 * 结构不合法返回 null（后续 StringData 的起点不可知，整个链接放弃）。
 */
function readLinkInfoTarget(buffer: Buffer, start: number): string | null {
  if (start + 0x1c > buffer.length) return null
  const size = buffer.readUInt32LE(start)
  const headerSize = buffer.readUInt32LE(start + 4)
  if (size < 0x1c || headerSize < 0x1c || start + size > buffer.length) return null

  const flags = buffer.readUInt32LE(start + 8)
  if ((flags & 0x1) === 0) return '' // 没有本地路径（网络链接等）
  const hasUnicodeOffsets = headerSize >= 0x24 && size >= 0x24
  const localAnsiOffset = buffer.readUInt32LE(start + 16)
  const suffixAnsiOffset = buffer.readUInt32LE(start + 24)
  const localUnicodeOffset = hasUnicodeOffsets ? buffer.readUInt32LE(start + 28) : 0
  const suffixUnicodeOffset = hasUnicodeOffsets ? buffer.readUInt32LE(start + 32) : 0

  const inRange = (offset: number): boolean => offset >= 0x1c && offset < size
  const base =
    localUnicodeOffset > 0 && inRange(localUnicodeOffset)
      ? readCStringAt(buffer, start + localUnicodeOffset, true)
      : localAnsiOffset > 0 && inRange(localAnsiOffset)
        ? readCStringAt(buffer, start + localAnsiOffset, false)
        : ''
  const suffix =
    suffixUnicodeOffset > 0 && inRange(suffixUnicodeOffset)
      ? readCStringAt(buffer, start + suffixUnicodeOffset, true)
      : suffixAnsiOffset > 0 && inRange(suffixAnsiOffset)
        ? readCStringAt(buffer, start + suffixAnsiOffset, false)
        : ''

  if (!base) return suffix
  if (!suffix) return base
  return base.endsWith('\\') || suffix.startsWith('\\')
    ? base + suffix
    : `${base}\\${suffix}`
}

/** 文件/文件夹名里不可能出现路径分隔符；拒绝异常名字，防止拼出根外路径 */
function isPlainName(name: string): boolean {
  return (
    name.length > 0 &&
    name !== '.' &&
    name !== '..' &&
    !/[\\/:*?"<>|\0]/.test(name)
  )
}

/**
 * 解析 LinkTargetIDList，还原文件系统路径。
 * 开始菜单里大量快捷方式（系统工具、Qt Creator 等）只有 IDList、没有 LinkInfo，
 * 这里按 shell item 顺序拼出 "盘符 + 各级名字"；无法确认是普通文件时返回 null。
 */
function parseShellIdList(buffer: Buffer, start: number, size: number): string | null {
  const end = start + size
  let offset = start
  let root = ''
  const segments: string[] = []
  let lastIsFile = false

  while (offset + 2 <= end) {
    const itemSize = buffer.readUInt16LE(offset)
    if (itemSize === 0) break
    if (itemSize < 3 || offset + itemSize > end) return null
    const type = buffer[offset + 2]
    const dataStart = offset + 3
    const itemEnd = offset + itemSize

    if (type === 0x1f) {
      // 根节点（"此电脑"）：只有 CLSID，跳过
    } else if (type === 0x2e || type === 0x2f) {
      // 盘符 / 卷根（ANSI "D:\"）
      const nul = buffer.indexOf(0, dataStart)
      if (nul < 0 || nul >= itemEnd) return null
      root = decodeAnsi(buffer.subarray(dataStart, nul))
      segments.length = 0
      lastIsFile = false
    } else if (type === 0x30 || type === 0x31 || type === 0x32) {
      // 文件系统条目：FileSize(4) + FileTime(4) + Attributes(2) + 保留(1) + ANSI 主名(\0)
      const nameStart = dataStart + 11
      if (nameStart >= itemEnd) return null
      const nul = buffer.indexOf(0, nameStart)
      if (nul < 0 || nul >= itemEnd) return null
      const name = decodeAnsi(buffer.subarray(nameStart, nul))
      if (!isPlainName(name)) return null
      segments.push(name)
      lastIsFile = type !== 0x31
    } else {
      // 网络位置、控制面板等：不做猜测
      return null
    }

    offset += itemSize
  }

  if (!root || !segments.length || !lastIsFile) return null
  let target = root
  for (const segment of segments) {
    target = target.endsWith('\\') ? target + segment : `${target}\\${segment}`
  }
  return target
}

/**
 * 读 ExtraData 里的 EnvironmentVariableDataBlock（系统工具的快捷方式常用：
 * `%windir%\system32\cmd.exe`）。签名 0xA0000001，后接 ANSI(260) + Unicode(520)。
 */
function readEnvironmentTarget(buffer: Buffer, start: number): string {
  let offset = start
  while (offset + 8 <= buffer.length) {
    const size = buffer.readUInt32LE(offset)
    if (size < 4) break
    if (size > buffer.length - offset) break
    const signature = buffer.readUInt32LE(offset + 4)
    if (signature === ENVIRONMENT_BLOCK_SIGNATURE && size >= ENVIRONMENT_BLOCK_SIZE) {
      const nameOffset = offset + 8 + 260
      const nameEnd = Math.min(nameOffset + 520, buffer.length)
      const text = buffer.toString('utf16le', nameOffset, nameEnd)
      const nul = text.indexOf('\0')
      return nul >= 0 ? text.slice(0, nul) : text
    }
    offset += size
  }
  return ''
}

/** StringData：2 字节字符数 + 字符内容（IsUnicode 时 UTF-16LE） */
function readStringData(reader: Reader, unicode: boolean): string {
  const count = reader.u16()
  if (unicode) {
    const bytes = count * 2
    if (reader.remaining < bytes) throw new RangeError('short string')
    const text = reader.buffer.toString(
      'utf16le',
      reader.offset,
      reader.offset + bytes
    )
    reader.skip(bytes)
    return text
  }
  if (reader.remaining < count) throw new RangeError('short string')
  const text = decodeAnsi(
    reader.buffer.subarray(reader.offset, reader.offset + count)
  )
  reader.skip(count)
  return text
}

/**
 * 解析 Windows 命令行参数字符串（按 CommandLineToArgvW 的规则拆成数组）。
 * 只拆参数，不展开变量、不做通配符。
 */
export function splitWindowsArguments(value: string): string[] {
  const result: string[] = []
  let current = ''
  let started = false
  let quoted = false
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i]
    if (ch === '\\') {
      let slashes = 0
      while (i < value.length && value[i] === '\\') {
        slashes += 1
        i += 1
      }
      if (i < value.length && value[i] === '"') {
        current += '\\'.repeat(Math.floor(slashes / 2))
        if (slashes % 2 === 0) {
          quoted = !quoted
        } else {
          current += '"'
        }
        started = true
        continue
      }
      current += '\\'.repeat(slashes)
      started = true
      i -= 1
      continue
    }
    if (ch === '"') {
      quoted = !quoted
      started = true
      continue
    }
    if (!quoted && (ch === ' ' || ch === '\t')) {
      if (started) {
        result.push(current)
        current = ''
        started = false
      }
      continue
    }
    current += ch
    started = true
  }
  if (started) result.push(current)
  return result
}

/**
 * 解析一个 `.lnk`（纯函数，测试直接调用）。
 * `linkPath` 用于把相对目标（RelativePath）解析成绝对路径。
 */
export function parseShellLink(
  buffer: Buffer,
  linkPath = '',
  env: NodeJS.ProcessEnv = process.env
): ShellLinkInfo | null {
  if (buffer.length < HEADER_SIZE) return null
  if (buffer.readUInt32LE(0) !== HEADER_SIZE) return null
  if (!buffer.subarray(4, 20).equals(SHELL_LINK_CLSID)) return null

  const flags = buffer.readUInt32LE(20)
  const unicode = (flags & IS_UNICODE) !== 0
  const reader = new Reader(buffer, HEADER_SIZE)

  try {
    let idListTarget = ''
    if (flags & HAS_TARGET_ID_LIST) {
      const size = reader.u16()
      const parsed = parseShellIdList(buffer, reader.offset, size)
      if (parsed) idListTarget = parsed
      reader.skip(size)
    }

    let linkInfoTarget = ''
    if (flags & HAS_LINK_INFO) {
      const start = reader.offset
      if (start + 4 > buffer.length) return null
      const size = buffer.readUInt32LE(start)
      const parsed = readLinkInfoTarget(buffer, start)
      if (parsed === null) return null
      linkInfoTarget = parsed
      reader.skip(size)
    }

    let relativePath = ''
    let workingDir = ''
    let argumentLine = ''
    let icon = ''
    if (flags & HAS_NAME) readStringData(reader, unicode)
    if (flags & HAS_RELATIVE_PATH) relativePath = readStringData(reader, unicode)
    if (flags & HAS_WORKING_DIR) workingDir = readStringData(reader, unicode)
    if (flags & HAS_ARGUMENTS) argumentLine = readStringData(reader, unicode)
    if (flags & HAS_ICON_LOCATION) icon = readStringData(reader, unicode)

    // ExtraData 在 StringData 之后；只有前两种目标来源都缺失时才用环境变量块
    const envTarget = flags & HAS_EXP_STRING
      ? readEnvironmentTarget(buffer, reader.offset)
      : ''

    const linkDir = linkPath ? winPath.dirname(linkPath) : ''
    let target = expandWindowsEnv(linkInfoTarget || idListTarget || envTarget, env)
    if (target && !winPath.isAbsolute(target) && relativePath) {
      target = winPath.resolve(linkDir || process.cwd(), target)
    }
    if (!target && relativePath) {
      const relative = expandWindowsEnv(relativePath, env)
      target = winPath.isAbsolute(relative)
        ? relative
        : winPath.resolve(linkDir || process.cwd(), relative)
    }
    if (!target || !winPath.isAbsolute(target)) return null

    let resolvedWorkingDir = expandWindowsEnv(workingDir, env)
    if (resolvedWorkingDir && !winPath.isAbsolute(resolvedWorkingDir) && linkDir) {
      resolvedWorkingDir = winPath.resolve(linkDir, resolvedWorkingDir)
    }

    return {
      target,
      args: splitWindowsArguments(argumentLine),
      workingDir: resolvedWorkingDir || winPath.dirname(target),
      icon
    }
  } catch {
    return null
  }
}

/** 开始菜单 Programs 根（当前用户优先） */
export function startMenuRoots(env: NodeJS.ProcessEnv = process.env): string[] {
  const roots: string[] = []
  const appData = env.APPDATA
  const programData = env.ProgramData || env.PROGRAMDATA
  if (appData) {
    roots.push(
      winPath.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs')
    )
  }
  if (programData) {
    roots.push(
      winPath.join(programData, 'Microsoft', 'Windows', 'Start Menu', 'Programs')
    )
  }
  return roots
}

function isWindowsExecutable(candidate: string): boolean {
  try {
    const stat = fs.statSync(candidate)
    if (!stat.isFile()) return false
    return ['.exe', '.com'].includes(winPath.extname(candidate).toLowerCase())
  } catch {
    return false
  }
}

interface ShortcutFile {
  id: string
  filePath: string
  baseName: string
}

function collectShortcutFiles(
  root: string,
  files: ShortcutFile[],
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
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.lnk')) continue
      let fileReal: string
      let stat: fs.Stats
      try {
        fileReal = fs.realpathSync(full)
        // 符号链接/junction 可能把文件指到根外：只接受仍在根内的
        const relative = path.relative(rootReal, fileReal)
        if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
          continue
        }
        stat = fs.statSync(fileReal)
      } catch {
        continue
      }
      if (!stat.isFile() || stat.size > MAX_FILE_BYTES) continue

      const id = path
        .relative(root, full)
        .replace(/\.lnk$/i, '')
        .split(/[\\/]/)
        .join('-')
      if (skippedIds.has(id)) continue
      skippedIds.add(id)
      budget.count += 1

      files.push({
        id,
        filePath: fileReal,
        baseName: path.basename(full, path.extname(full))
      })
    }
  }

  walk(rootReal, 0)
}

/** 快捷方式文件名 → 显示名（去掉系统自动加的" - 快捷方式"后缀） */
function displayName(baseName: string): string {
  const cleaned = baseName.replace(/\s*[-–—]\s*(快捷方式|Shortcut)$/i, '').trim()
  return cleaned || baseName
}

export interface WindowsScanOptions {
  refresh?: boolean
  env?: NodeJS.ProcessEnv
  now?: number
  isExecutable?: (candidate: string) => boolean
}

interface WindowsCacheState {
  apps: ScannedApp[]
  scannedAt: number
}

let cache: WindowsCacheState | null = null

/** 扫描开始菜单应用（60s 缓存；`refresh` 强制重扫） */
export function scanWindowsApplications(
  options: WindowsScanOptions = {}
): ScannedApp[] {
  const now = options.now ?? Date.now()
  if (!options.refresh && cache && now - cache.scannedAt < CACHE_TTL_MS) {
    return cache.apps
  }

  const env = options.env ?? process.env
  const isExecutable = options.isExecutable ?? isWindowsExecutable
  const files: ShortcutFile[] = []
  const seenIds = new Set<string>()
  const budget = { count: 0 }
  for (const root of startMenuRoots(env)) {
    collectShortcutFiles(root, files, seenIds, budget)
  }

  const apps: ScannedApp[] = []
  const seenTargets = new Set<string>()
  for (const file of files) {
    let buffer: Buffer
    try {
      buffer = fs.readFileSync(file.filePath)
    } catch {
      continue
    }
    const link = parseShellLink(buffer, file.filePath, env)
    if (!link || !winPath.isAbsolute(link.target)) continue

    // 同一个程序可能在两个开始菜单根里各有一个快捷方式：按目标+参数去重
    const key = `${link.target.toLowerCase()}\0${link.args.join('\0').toLowerCase()}`
    if (seenTargets.has(key)) continue
    seenTargets.add(key)

    const executable = isExecutable(link.target)
    const extension = winPath.extname(link.target)
    apps.push({
      id: file.id,
      name: displayName(file.baseName),
      genericName: winPath.basename(link.target, extension),
      execPath: link.target,
      execArgv: [link.target, ...link.args],
      hasArgs: link.args.length > 0,
      needsTerminal: false,
      available: executable,
      wrapper: WRAPPER_BASENAMES.has(winPath.basename(link.target).toLowerCase()),
      desktopFile: file.filePath,
      icon: link.icon,
      workingDir: link.workingDir || winPath.dirname(link.target)
    })
  }

  cache = { apps, scannedAt: now }
  return apps
}

/** 清空缓存（测试/刷新用） */
export function clearWindowsAppCache(): void {
  cache = null
}
