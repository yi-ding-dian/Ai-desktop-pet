/**
 * 编码代理运行时探测（2026-10-23）。
 *
 * 三件事：
 * - 算出「应用自己的 dsh 安装目录」（按用户隔离，不污染全局 npm）；
 * - 探测当前可用状态：应用内 runtime / 系统 PATH / 只能靠 npx / 完全不可用；
 * - 给设置页提供可展示的结构化结果。
 *
 * 只读：本文件不安装、不删除任何东西（安装见 installer.ts）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { CodingRuntimeStatus } from '../ipc/channels'
import {
  DEFAULT_DSH_PACKAGE,
  MIN_DSH_VERSION,
  findOnPath,
  probeDshVersion,
  versionAtLeast
} from './command'

export type { CodingRuntimeState, CodingRuntimeStatus } from '../ipc/channels'

export interface DetectOptions {
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  pathValue?: string
  fileExists?: (target: string) => boolean
  probeVersion?: (executable: string, platform: NodeJS.Platform) => string | null
}

/** 用户级数据目录（Windows 用 LOCALAPPDATA，避免 Roaming 同步几百 MB runtime） */
export function codingDataHome(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): string {
  if (platform === 'win32') {
    return path.normalize(
      env.LOCALAPPDATA || path.join(env.USERPROFILE || os.homedir(), 'AppData', 'Local')
    )
  }
  if (platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support')
  }
  return path.normalize(env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'))
}

/** 应用内 dsh 安装目录 */
export function codingRuntimeDir(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): string {
  return path.join(codingDataHome(env, platform), 'ai-desktop-pet', 'dsh-runtime')
}

/**
 * 编码代理的隔离 Harness Home。
 * 复用宠物 Key 时必须用它：dsh 的凭据优先级是「存储文件 > 启动环境」，
 * 用用户自己的 ~/.dsh 会继续读到里面那份（可能已失效的）旧 Key。
 */
export function codingHarnessHome(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): string {
  return path.join(codingDataHome(env, platform), 'ai-desktop-pet', 'dsh-home')
}

/** npm 安装后的可执行文件路径 */
export function codingRuntimeExecutable(
  runtimeDir: string,
  platform: NodeJS.Platform = process.platform
): string {
  const bin = path.join(runtimeDir, 'node_modules', '.bin')
  return platform === 'win32' ? path.join(bin, 'dsh.cmd') : path.join(bin, 'dsh')
}

/** 存在则返回应用内 runtime 的路径（供任务启动时优先使用） */
export function resolveAppRuntime(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): string | null {
  const target = codingRuntimeExecutable(codingRuntimeDir(env, platform), platform)
  try {
    return fs.existsSync(target) ? target : null
  } catch {
    return null
  }
}

function toolNames(base: string, platform: NodeJS.Platform): string[] {
  return platform === 'win32'
    ? [`${base}.cmd`, `${base}.exe`, `${base}.bat`, base]
    : [base]
}

/** 探测当前编码代理可用性（同步；设置页点「检测」时调用，约几百毫秒） */
export function detectCodingRuntime(options: DetectOptions = {}): CodingRuntimeStatus {
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  const pathValue = options.pathValue ?? env.PATH ?? env.Path ?? ''
  const fileExists = options.fileExists ?? ((target: string) => fs.existsSync(target))
  const probe = options.probeVersion ?? probeDshVersion

  const runtimeDir = codingRuntimeDir(env, platform)
  const runtimeExe = codingRuntimeExecutable(runtimeDir, platform)
  const runtimeInstalled = fileExists(runtimeExe)

  const npmAvailable = Boolean(
    findOnPath(toolNames('npm', platform), pathValue, platform, fileExists)
  )
  const npxAvailable = Boolean(
    findOnPath(toolNames('npx', platform), pathValue, platform, fileExists)
  )

  const base = { runtimeDir, runtimeInstalled, npmAvailable, npxAvailable }

  if (runtimeInstalled) {
    const version = probe(runtimeExe, platform)
    if (version && versionAtLeast(version, MIN_DSH_VERSION)) {
      return {
        ...base,
        state: 'ready',
        source: 'app',
        version,
        executable: runtimeExe,
        message: `小兔内置的编码代理已就绪（${version}）`
      }
    }
    return {
      ...base,
      state: 'outdated',
      source: 'app',
      version,
      executable: runtimeExe,
      message: `内置的编码代理版本过旧${version ? `（${version}）` : ''}，需要修复安装`
    }
  }

  const dsh = findOnPath(toolNames('dsh', platform), pathValue, platform, fileExists)
  if (dsh) {
    const version = probe(dsh, platform)
    if (version && versionAtLeast(version, MIN_DSH_VERSION)) {
      return {
        ...base,
        state: 'ready',
        source: 'path',
        version,
        executable: dsh,
        message: `已使用本机安装的 DeepSeek Harness（${version}）`
      }
    }
    return {
      ...base,
      state: 'outdated',
      source: 'path',
      version,
      executable: dsh,
      message:
        `本机的 dsh 版本过旧${version ? `（${version}）` : ''}，` +
        `需要 ≥ ${MIN_DSH_VERSION}；可以装到小兔自己的目录`
    }
  }

  if (npxAvailable) {
    return {
      ...base,
      state: 'npx-only',
      source: 'npx',
      version: null,
      executable: null,
      message: `还没安装编码代理；首次使用会通过 npx 临时下载 ${DEFAULT_DSH_PACKAGE}（需要联网）`
    }
  }

  return {
    ...base,
    state: 'unavailable',
    source: 'none',
    version: null,
    executable: null,
    message: npmAvailable
      ? '还没安装编码代理，点下面的「安装」即可'
      : '没找到 Node.js / npm，无法安装编码代理；请先安装 Node.js'
  }
}
