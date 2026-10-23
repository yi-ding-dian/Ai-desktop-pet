/**
 * 编码代理命令解析（2026-10-23）。
 *
 * 目标：跨平台找到 `dsh`，并拼出 `--profile acp` 的启动参数。
 *
 * 取舍：
 * - Windows 的 npm 全局命令是 `.cmd` 批处理，`spawn` 不能直接执行；这里在
 *   `.cmd/.bat` 场景走 `shell: true`（命令与参数全是本模块的字面量，用户任务
 *   走 stdin，不经过 argv，所以没有注入面）；
 * - 找不到 `dsh` 时回退 `npx -y @deepseek-ai/dsh@<pin>`；版本锁死，避免
 *   developer preview 的破坏性变更直接把功能打挂；
 * - `PET_DSH_COMMAND` 可覆盖（自测/自定义安装位置）。
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

/** 回退安装的 dsh 版本：与本项目联调通过的版本，不跟随 latest */
export const DEFAULT_DSH_PACKAGE = '@deepseek-ai/dsh@0.2.1-rc.2'

/** ACP 服务的固定参数 */
export const ACP_PROFILE_ARGS = ['--profile', 'acp']

/** 带 `acp` profile 的最低版本；更旧的 dsh 会报 profile 不存在 */
export const MIN_DSH_VERSION = '0.2.0'

export type HarnessSource = 'custom' | 'app' | 'path' | 'npx'

export interface HarnessCommand {
  source: HarnessSource
  /** 可执行文件绝对路径（或 PATH 中的名字） */
  executable: string
  /** 可执行文件自身的参数（不含 --profile acp） */
  baseArgs: string[]
  /** 给用户看的来源说明（错误提示里用） */
  display: string
}

export interface SpawnSpec {
  command: string
  args: string[]
  shell: boolean
}

export interface ResolveOptions {
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  pathValue?: string
  fileExists?: (target: string) => boolean
  /** 读版本号（测试注入）；返回 null 表示读不到 */
  probeVersion?: (executable: string, platform: NodeJS.Platform) => string | null
  /** 应用内安装的 dsh 可执行文件（存在则优先于 PATH） */
  appRuntime?: string | null
}

/** 解析 `x.y.z`；不是语义化版本返回 null */
export function parseVersion(text: string): [number, number, number] | null {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(text)
  if (!match) return null
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

/** a >= b */
export function versionAtLeast(a: string, b: string): boolean {
  const left = parseVersion(a)
  const right = parseVersion(b)
  if (!left || !right) return true
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] > right[index]
  }
  return true
}

/** 版本探测结果缓存：每个可执行文件只同步跑一次 `--version` */
const versionCache = new Map<string, string | null>()

/** 默认版本探测：同步执行 `--version`（结果缓存，避免每个任务都阻塞主进程） */
export function probeDshVersion(executable: string, platform: NodeJS.Platform = process.platform): string | null {
  const key = `${platform}:${executable}`
  if (versionCache.has(key)) return versionCache.get(key) ?? null
  let version: string | null = null
  try {
    // 复用 toSpawnSpec：.cmd 显式走 cmd.exe，避免 Node 对 shell:true + args 的 DEP0190
    const spec = toSpawnSpec(executable, ['--version'], platform)
    const output = execFileSync(spec.command, spec.args, {
      encoding: 'utf8',
      timeout: 5_000,
      windowsHide: true,
      shell: spec.shell
    })
    version = output.trim()
  } catch {
    version = null
  }
  versionCache.set(key, version)
  return version
}

/** 只找 npx（`dsh` 版本过旧时的回退） */
export function resolveNpxCommand(
  options: ResolveOptions = {}
): HarnessCommand | null {
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  const pathValue = options.pathValue ?? env.PATH ?? env.Path ?? ''
  const fileExists = options.fileExists ?? ((target: string) => fs.existsSync(target))
  const npxNames = platform === 'win32' ? ['npx.cmd', 'npx.exe', 'npx'] : ['npx']
  const npx = findOnPath(npxNames, pathValue, platform, fileExists)
  if (!npx) return null
  return {
    source: 'npx',
    executable: npx,
    baseArgs: ['-y', DEFAULT_DSH_PACKAGE],
    display: `${npx} -y ${DEFAULT_DSH_PACKAGE}`
  }
}

/** Windows 批处理/命令脚本需要用 shell 执行 */
export function needsShell(executable: string, platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'win32' && /\.(cmd|bat)$/i.test(executable)
}

/** 在 PATH 里按候选名找第一个存在的文件（不执行、不猜别名） */
export function findOnPath(
  names: string[],
  pathValue: string,
  platform: NodeJS.Platform = process.platform,
  fileExists: (target: string) => boolean = (target) => fs.existsSync(target)
): string | null {
  const dirs = pathValue.split(path.delimiter).filter(Boolean)
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = path.join(dir, name)
      if (fileExists(candidate)) return candidate
    }
  }
  return null
}

/**
 * 解析编码代理命令。
 * 顺序：PET_DSH_COMMAND → PATH 上的 dsh → npx 回退。
 */
export function resolveHarnessCommand(options: ResolveOptions = {}): HarnessCommand {
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  const pathValue = options.pathValue ?? env.PATH ?? env.Path ?? ''
  const fileExists = options.fileExists ?? ((target: string) => fs.existsSync(target))

  const custom = (env.PET_DSH_COMMAND ?? '').trim()
  if (custom) {
    return {
      source: 'custom',
      executable: custom,
      baseArgs: [],
      display: `PET_DSH_COMMAND=${custom}`
    }
  }

  // 应用自己装的 runtime（设置页「安装编码代理」）优先于系统 PATH
  const appRuntime = (options.appRuntime ?? env.PET_DSH_RUNTIME ?? '').trim()
  if (appRuntime && fileExists(appRuntime)) {
    return {
      source: 'app',
      executable: appRuntime,
      baseArgs: [],
      display: appRuntime
    }
  }

  const dshNames =
    platform === 'win32' ? ['dsh.cmd', 'dsh.exe', 'dsh.bat', 'dsh'] : ['dsh']
  const found = findOnPath(dshNames, pathValue, platform, fileExists)
  if (found) {
    const probe = options.probeVersion ?? probeDshVersion
    const version = probe(found, platform)
    if (version === null || versionAtLeast(version, MIN_DSH_VERSION)) {
      return { source: 'path', executable: found, baseArgs: [], display: found }
    }
    // 旧版没有 acp profile：优先回退 npx（本机全局版本过旧的常见情况）
    const npxFallback = resolveNpxCommand({ env, platform, pathValue, fileExists })
    if (npxFallback) return npxFallback
    throw new Error(
      `本机的 dsh 版本是 ${version}，没有 acp 服务（需要 ≥ ${MIN_DSH_VERSION}）。` +
        '请执行 `npm install -g @deepseek-ai/dsh@0.2.1-rc.2` 升级。'
    )
  }

  const npx = resolveNpxCommand({ env, platform, pathValue, fileExists })
  if (npx) return npx

  throw new Error(
    '没找到 DeepSeek Harness（dsh）。请先安装 Node.js，再执行 ' +
      '`npm install -g @deepseek-ai/dsh@0.2.1-rc.2`；或在环境变量里设置 PET_DSH_COMMAND。'
  )
}

/** 引号包裹（仅用于 shell:true 的字面量命令；不做通用转义） */
function quoteArg(value: string): string {
  return /[\s"&|<>^]/.test(value) ? `"${value}"` : value
}

/**
 * 把「可执行文件 + 参数」转成 spawn 参数。
 *
 * `.cmd/.bat` 用 cmd.exe 显式执行（`/d /s /c "<命令行>"`）：比 `shell: true`
 * 少一层 Node 的参数拼接（Node 24 会为此发 DEP0190），且参数仍全是本模块的
 * 字面量——用户任务走 stdin，不经过 argv。
 */
export function toSpawnSpec(
  executable: string,
  args: string[],
  platform: NodeJS.Platform = process.platform
): SpawnSpec {
  if (needsShell(executable, platform)) {
    const line = [executable, ...args].map(quoteArg).join(' ')
    const comspec = process.env.ComSpec || 'cmd.exe'
    return { command: comspec, args: ['/d', '/s', '/c', line], shell: false }
  }
  return { command: executable, args, shell: false }
}
