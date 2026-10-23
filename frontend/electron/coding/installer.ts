/**
 * 编码代理安装/卸载（2026-10-23）。
 *
 * 安装目标固定为用户级应用数据目录下的 `dsh-runtime/`（见 runtime.ts）：
 * - 不做全局 `npm install -g`，不需要管理员权限，不污染系统 npm；
 * - 版本锁死，失败可重试，可单独卸载；
 * - 安装过程流式回传输出，设置页能看见进度。
 *
 * 安全：安装命令与参数全部是本模块的字面量，用户输入不进入 argv。
 */
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import type { CodingInstallProgress, CodingInstallResult } from '../ipc/channels'
import { killProcessTree } from './acp'
import {
  DEFAULT_DSH_PACKAGE,
  MIN_DSH_VERSION,
  findOnPath,
  probeDshVersion,
  toSpawnSpec,
  versionAtLeast
} from './command'
import {
  codingDataHome,
  codingRuntimeDir,
  codingRuntimeExecutable,
  detectCodingRuntime
} from './runtime'

/** 安装超时：npm 拉取几百 MB，给足 15 分钟 */
const INSTALL_TIMEOUT_MS = 15 * 60 * 1000
/** 输出只保留最后若干行，避免日志吃内存 */
const TAIL_LIMIT = 60
/** 单行进度长度上限 */
const LINE_LIMIT = 500

/** npm 安装参数（纯函数，便于测试） */
export function buildInstallArgs(runtimeDir: string): string[] {
  return [
    'install',
    '--prefix',
    runtimeDir,
    '--no-audit',
    '--no-fund',
    '--no-progress',
    DEFAULT_DSH_PACKAGE
  ]
}

/** 找 npm（Windows 上是 npm.cmd） */
export function findNpm(env: NodeJS.ProcessEnv = process.env): string | null {
  const platform = process.platform
  const pathValue = env.PATH ?? env.Path ?? ''
  const names =
    platform === 'win32' ? ['npm.cmd', 'npm.exe', 'npm.bat', 'npm'] : ['npm']
  return findOnPath(names, pathValue, platform)
}

class HarnessInstaller {
  private child: ChildProcess | null = null
  private cancelled = false
  private tail: string[] = []
  private timeout: NodeJS.Timeout | null = null

  get installing(): boolean {
    return this.child !== null
  }

  /** 安装到应用目录；onProgress 用于流式回传（IPC 推送） */
  async install(
    onProgress: (progress: CodingInstallProgress) => void
  ): Promise<CodingInstallResult> {
    if (this.child) return { ok: false, message: '正在安装中，请稍等。' }

    const npm = findNpm()
    if (!npm) {
      return {
        ok: false,
        message: '没找到 npm。请先安装 Node.js（自带 npm）后再试。'
      }
    }

    const runtimeDir = codingRuntimeDir()
    const executable = codingRuntimeExecutable(runtimeDir)
    try {
      fs.mkdirSync(runtimeDir, { recursive: true })
    } catch (error) {
      return {
        ok: false,
        message: `不能创建安装目录：${error instanceof Error ? error.message : String(error)}`
      }
    }

    this.cancelled = false
    this.tail = []
    onProgress({ phase: 'starting', message: `正在安装 ${DEFAULT_DSH_PACKAGE}…` })

    const spec = toSpawnSpec(npm, buildInstallArgs(runtimeDir))
    const child = spawn(spec.command, spec.args, {
      cwd: runtimeDir,
      env: { ...process.env, npm_config_loglevel: 'http' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      shell: spec.shell
    })
    this.child = child

    const pushLine = (line: string): void => {
      const text = line.trim().slice(0, LINE_LIMIT)
      if (!text) return
      this.tail.push(text)
      if (this.tail.length > TAIL_LIMIT) this.tail.shift()
      onProgress({ phase: 'output', line: text })
    }
    if (child.stdout) {
      readline.createInterface({ input: child.stdout }).on('line', pushLine)
    }
    if (child.stderr) {
      readline.createInterface({ input: child.stderr }).on('line', pushLine)
    }

    const exitCode = await new Promise<number | null>((resolve) => {
      const finish = (code: number | null): void => resolve(code)
      child.once('error', () => finish(-1))
      child.once('exit', (code) => finish(code))
      this.timeout = setTimeout(() => {
        pushLine('安装超时，已中止')
        killProcessTree(child.pid)
        finish(-1)
      }, INSTALL_TIMEOUT_MS)
    })

    if (this.timeout) {
      clearTimeout(this.timeout)
      this.timeout = null
    }
    this.child = null

    if (this.cancelled) {
      onProgress({ phase: 'cancelled', message: '已取消安装' })
      return { ok: false, message: '已取消安装。' }
    }
    if (exitCode !== 0) {
      const tail = this.tail.slice(-6).join('\n')
      const message = `安装失败（npm 退出码 ${String(exitCode)}）。${tail ? `\n${tail}` : ''}`
      onProgress({ phase: 'error', message })
      return { ok: false, message }
    }

    onProgress({ phase: 'verifying', message: '安装完成，正在校验…' })
    if (!fs.existsSync(executable)) {
      const message = '安装命令执行完了，但没找到 dsh 可执行文件，请重试或改用系统安装。'
      onProgress({ phase: 'error', message })
      return { ok: false, message }
    }
    const version = probeDshVersion(executable)
    if (!version || !versionAtLeast(version, MIN_DSH_VERSION)) {
      const message = `装上的版本不可用（${version ?? '未知版本'}），需要 ≥ ${MIN_DSH_VERSION}。`
      onProgress({ phase: 'error', message })
      return { ok: false, message }
    }

    onProgress({ phase: 'done', message: `安装完成（${version}）` })
    return {
      ok: true,
      message: `编码代理已安装到小兔的数据目录（${version}）。`,
      status: detectCodingRuntime()
    }
  }

  cancel(): CodingInstallResult {
    if (!this.child) return { ok: false, message: '现在没有在安装。' }
    this.cancelled = true
    killProcessTree(this.child.pid)
    return { ok: true, message: '正在取消安装…' }
  }
}

export const harnessInstaller = new HarnessInstaller()

/** 删除应用内 runtime（只允许删自己算出来的那个目录） */
export function uninstallHarness(
  options: { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform } = {}
): CodingInstallResult {
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  const dir = path.resolve(codingRuntimeDir(env, platform))
  const dataHome = path.resolve(codingDataHome(env, platform))
  const expectedName = 'dsh-runtime'
  if (
    path.basename(dir) !== expectedName ||
    !dir.startsWith(dataHome + path.sep)
  ) {
    return { ok: false, message: '安装目录校验失败，已拒绝删除。' }
  }
  if (!fs.existsSync(dir)) {
    return { ok: false, message: '没有找到小兔安装的编码代理。' }
  }
  try {
    fs.rmSync(dir, { recursive: true, force: true })
  } catch (error) {
    return {
      ok: false,
      message: `删除失败：${error instanceof Error ? error.message : String(error)}`
    }
  }
  return {
    ok: true,
    message: '已删除小兔安装的编码代理（不影响你系统里自己装的 dsh）。',
    status: detectCodingRuntime({ env, platform })
  }
}
