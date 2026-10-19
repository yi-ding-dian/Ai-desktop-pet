/**
 * .desktop 解析（2026-10-19，纯逻辑，不 import electron）。
 *
 * 只服务 launcher 域：把 `.desktop` 的 `[Desktop Entry]` 解析成可启动的 argv。
 * 边界：
 * - **不做 shell 解释**：Exec 按桌面规范拆成参数数组，引号/反斜杠只按规范处理；
 * - 字段码（%f/%U/%i…）剥离——只保留 `.desktop` 自带的字面参数；
 * - 只读 `[Desktop Entry]` 段，本地化 Name 按 locale 候选匹配；
 * - 目标解析（`resolveExecTarget`）跳过 `env KEY=VALUE`，并把裸命令按 PATH 换成
 *   绝对路径；调用方必须再对返回路径做独立可执行校验。
 */

/** `[Desktop Entry]` 的原始字段（本地化 Name 保留在 map 里，由 pickLocalized 选） */
export interface DesktopEntry {
  type: string
  name: string
  genericName: string
  nameMap: Record<string, string>
  genericNameMap: Record<string, string>
  exec: string
  tryExec: string
  path: string
  terminal: boolean
  noDisplay: boolean
  hidden: boolean
  icon: string
}

/** 桌面规范里需要用反斜杠转义的值字符 */
function unescapeValue(value: string): string {
  let out = ''
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i]
    if (ch !== '\\' || i + 1 >= value.length) {
      out += ch
      continue
    }
    const next = value[i + 1]
    if (next === 's') out += ' '
    else if (next === 'n') out += '\n'
    else if (next === 't') out += '\t'
    else if (next === 'r') out += '\r'
    else if (next === '\\') out += '\\'
    else out += next
    i += 1
  }
  return out
}

/** 解析 `.desktop` 文本；没有 `[Desktop Entry]` 或缺少 Type 时返回 null */
export function parseDesktopEntry(content: string): DesktopEntry | null {
  const entry: DesktopEntry = {
    type: '',
    name: '',
    genericName: '',
    nameMap: {},
    genericNameMap: {},
    exec: '',
    tryExec: '',
    path: '',
    terminal: false,
    noDisplay: false,
    hidden: false,
    icon: ''
  }
  let inSection = false
  let seen = false
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    if (line.startsWith('[')) {
      if (line === '[Desktop Entry]') {
        inSection = true
        seen = true
      } else if (inSection) {
        break // 只读第一段 [Desktop Entry]
      }
      continue
    }
    if (!inSection) continue
    const index = line.indexOf('=')
    if (index <= 0) continue
    const key = line.slice(0, index).trim()
    const value = unescapeValue(line.slice(index + 1).trim())

    if (key === 'Type') entry.type = value
    else if (key === 'Name') entry.name = value
    else if (key === 'GenericName') entry.genericName = value
    else if (key === 'Exec') entry.exec = value
    else if (key === 'TryExec') entry.tryExec = value
    else if (key === 'Path') entry.path = value
    else if (key === 'Icon') entry.icon = value
    else if (key === 'Terminal') entry.terminal = value.toLowerCase() === 'true'
    else if (key === 'NoDisplay') entry.noDisplay = value.toLowerCase() === 'true'
    else if (key === 'Hidden') entry.hidden = value.toLowerCase() === 'true'
    else if (key.startsWith('Name[') && key.endsWith(']')) {
      entry.nameMap[key.slice(5, -1)] = value
    } else if (key.startsWith('GenericName[') && key.endsWith(']')) {
      entry.genericNameMap[key.slice(12, -1)] = value
    }
  }
  return seen && entry.type ? entry : null
}

/** locale 候选：`zh_CN.UTF-8` → `zh_CN.UTF-8` / `zh_CN` / `zh-CN` / `zh`（大小写不敏感） */
export function localeCandidates(locale: string | undefined): string[] {
  const cleaned = String(locale || '').trim()
  if (!cleaned) return []
  const bare = cleaned.split('.')[0]
  const base = bare.split(/[-_]/)[0].toLowerCase()
  const result: string[] = []
  for (const item of [
    cleaned,
    bare,
    bare.replace(/_/g, '-'),
    bare.replace(/-/g, '_'),
    base
  ]) {
    if (item && !result.some((existing) => existing.toLowerCase() === item.toLowerCase())) {
      result.push(item)
    }
  }
  return result
}

/** 从本地化 map 里选值；没有匹配时回退到默认 Name/GenericName */
export function pickLocalized(
  map: Record<string, string>,
  fallback: string,
  locale: string | undefined
): string {
  const keys = Object.keys(map)
  const lowered = new Map(keys.map((key) => [key.toLowerCase(), key]))
  for (const candidate of localeCandidates(locale)) {
    const hit = lowered.get(candidate.toLowerCase())
    if (hit && map[hit]) return map[hit]
  }
  return fallback
}

/**
 * 按桌面规范拆 Exec：空白分隔、双引号分组、反斜杠转义；
 * **不是 shell**——不做变量展开、命令替换、管道或通配符。
 */
export function splitExec(value: string): string[] {
  const result: string[] = []
  let current = ''
  let started = false
  let quoted = false
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i]
    if (ch === '\\' && i + 1 < value.length) {
      const next = value[i + 1]
      // 规范只转义 " ` $ \；额外宽容 `\ ` / `\t`（手写 .desktop 常见）
      if (
        next === '"' ||
        next === '`' ||
        next === '$' ||
        next === '\\' ||
        next === ' ' ||
        next === '\t'
      ) {
        current += next
        started = true
        i += 1
        continue
      }
      // 桌面规范只转义上述字符；其它反斜杠原样保留
      current += ch
      started = true
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

/** 字段码：%f %F %u %U %d %D %n %N %i %c %k %v %m；%% → 字面 % */
const FIELD_CODES = 'fFuUdDnNickvm'

/** 剥离字段码并丢弃空参数（`%i` 直接丢弃，不展开 --icon） */
export function stripFieldCodes(argv: string[]): string[] {
  const result: string[] = []
  for (const arg of argv) {
    let out = ''
    for (let i = 0; i < arg.length; i += 1) {
      const ch = arg[i]
      if (ch === '%' && i + 1 < arg.length) {
        const next = arg[i + 1]
        if (next === '%') {
          out += '%'
          i += 1
          continue
        }
        if (FIELD_CODES.includes(next)) {
          i += 1
          continue
        }
      }
      out += ch
    }
    if (out) result.push(out)
  }
  return result
}

/** 是否 `env` 前缀（`env KEY=VALUE /path/app`） */
function isEnvName(name: string): boolean {
  return name === 'env' || name.endsWith('/env')
}

/** 跳过 `env` 与 `KEY=VALUE`，返回目标参数下标；没有目标返回 -1 */
export function execTargetIndex(argv: string[]): number {
  let index = 0
  if (index < argv.length && isEnvName(argv[index])) {
    index += 1
    while (index < argv.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[index])) {
      index += 1
    }
  }
  return index < argv.length ? index : -1
}

/**
 * 解析 Exec 目标为绝对路径：
 * - 绝对路径原样返回（调用方再校验可执行）；
 * - 裸命令在 PATH 中逐个查找，返回第一个 `isExecutable` 命中项；
 * - 找不到返回空串。
 */
export function resolveExecTarget(
  raw: string,
  pathEnv: string,
  isExecutable: (candidate: string) => boolean
): string {
  if (!raw) return ''
  if (raw.includes('/')) return raw
  for (const dir of String(pathEnv || '').split(':')) {
    if (!dir) continue
    const candidate = `${dir.replace(/\/$/, '')}/${raw}`
    if (isExecutable(candidate)) return candidate
  }
  return ''
}
