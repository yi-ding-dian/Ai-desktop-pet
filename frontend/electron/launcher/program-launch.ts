/**
 * 程序启动的安全校验与 spawn（2026-10-19，主进程 launcher 域）。
 *
 * **不要复用 `system/path-safety.ts`**：那边是"打开文件时拒绝可执行"，这里是
 * "只允许可执行"——语义相反，混用会互相破坏。
 *
 * 边界：
 * - 绝对路径、realpath、普通文件、真实可执行（POSIX 执行位 / Windows .exe|.com）；
 * - 拒绝 `.desktop`、目录、设备、`/proc|/sys|/dev`、shell/解释器本体；
 * - **永远 `shell:false`**，参数一律数组；spawn 前重新校验，缩小 TOCTOU 窗口；
 * - detached + stdio ignore：程序独立于宠物存活，宠物不跟踪、不 kill。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

/** 校验结果（失败 message 可直接展示） */
export interface LaunchCheck {
  ok: boolean
  code: string
  message?: string
  /** 校验通过后的真实绝对路径 */
  path?: string
}

export interface SpawnResult {
  ok: boolean
  code: string
  message?: string
}

/** 拒绝直接启动的 shell/解释器本体（防止借"启动程序"执行任意命令） */
const SHELL_BASENAMES = new Set([
  'sh',
  'bash',
  'dash',
  'zsh',
  'fish',
  'ksh',
  'csh',
  'tcsh',
  'cmd',
  'cmd.exe',
  'powershell',
  'powershell.exe',
  'pwsh',
  'pwsh.exe'
])

/** 拒绝的特殊文件系统前缀 */
const SPECIAL_PREFIXES = ['/proc', '/sys', '/dev']

/** Windows 上允许直接启动的后缀 */
const WINDOWS_EXEC_EXTENSIONS = new Set(['.exe', '.com'])

const INVALID_MESSAGE = '请提供可执行文件的绝对路径'

/** 目标是否是 shell/解释器本体 */
export function isShellBasename(target: string): boolean {
  return SHELL_BASENAMES.has(path.basename(target).toLowerCase())
}

function isSpecialPath(target: string): boolean {
  return SPECIAL_PREFIXES.some(
    (prefix) => target === prefix || target.startsWith(`${prefix}/`)
  )
}

/**
 * 校验一个路径能否被直接启动。
 * 失败返回 `{ok:false, code, message}`；成功返回 realpath。
 */
export function validateLaunchableProgram(raw: unknown): LaunchCheck {
  const text = typeof raw === 'string' ? raw.trim().replace(/^["'](.*)["']$/, '$1') : ''
  if (!text) {
    return { ok: false, code: 'launcher_invalid_path', message: INVALID_MESSAGE }
  }
  if (/[\0\r\n]/.test(text)) {
    return { ok: false, code: 'launcher_invalid_path', message: '路径里有非法字符' }
  }
  if (!path.isAbsolute(text)) {
    return { ok: false, code: 'launcher_invalid_path', message: INVALID_MESSAGE }
  }
  if (isSpecialPath(text.replace(/\\/g, '/'))) {
    return {
      ok: false,
      code: 'launcher_invalid_path',
      message: '不能启动系统特殊目录里的文件'
    }
  }

  let resolved: string
  let stat: fs.Stats
  try {
    resolved = fs.realpathSync.native
      ? fs.realpathSync.native(text)
      : fs.realpathSync(text)
    stat = fs.statSync(resolved)
  } catch {
    return {
      ok: false,
      code: 'launcher_invalid_path',
      message: '程序不存在（或磁盘未连接、没有权限）'
    }
  }

  if (path.extname(resolved).toLowerCase() === '.desktop') {
    return {
      ok: false,
      code: 'launcher_invalid_path',
      message: '这是应用启动器文件，不是可执行程序'
    }
  }
  if (stat.isDirectory()) {
    return {
      ok: false,
      code: 'launcher_not_regular_file',
      message: '这是文件夹，不是可执行程序'
    }
  }
  if (!stat.isFile()) {
    return {
      ok: false,
      code: 'launcher_not_regular_file',
      message: '只能启动普通文件'
    }
  }
  if (isShellBasename(resolved)) {
    return {
      ok: false,
      code: 'launcher_unsafe_program',
      message: '为了安全，小兔不能直接启动 shell；请填写具体程序'
    }
  }
  if (process.platform === 'win32') {
    if (!WINDOWS_EXEC_EXTENSIONS.has(path.extname(resolved).toLowerCase())) {
      return {
        ok: false,
        code: 'launcher_not_executable',
        message: '在 Windows 上只支持 .exe / .com 程序'
      }
    }
  } else if ((stat.mode & 0o111) === 0) {
    return {
      ok: false,
      code: 'launcher_not_executable',
      message: '这个文件没有可执行权限（可以用 chmod +x 添加）'
    }
  }

  return { ok: true, code: 'launcher_ok', path: resolved }
}

/** 工作目录：只接受存在且是目录的绝对路径；否则回退用户主目录 */
export function resolveWorkingDirectory(raw: unknown): string {
  const text = typeof raw === 'string' ? raw.trim() : ''
  if (text && path.isAbsolute(text)) {
    try {
      if (fs.statSync(text).isDirectory()) return text
    } catch {
      // 忽略，回退主目录
    }
  }
  return os.homedir()
}

/**
 * 以 detached 方式启动程序本体（参数数组，绝不经过 shell）。
 * 以 `spawn` 事件判定成功；`error`（ENOENT/EACCES 等）返回失败。
 */
export async function spawnDetached(
  execPath: string,
  args: string[],
  options: { cwd?: string; timeoutMs?: number } = {}
): Promise<SpawnResult> {
  const check = validateLaunchableProgram(execPath)
  if (!check.ok || !check.path) {
    return { ok: false, code: check.code, message: check.message }
  }

  return await new Promise<SpawnResult>((resolve) => {
    let settled = false
    const finish = (result: SpawnResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }

    let child: ReturnType<typeof spawn>
    try {
      child = spawn(check.path!, args, {
        cwd: options.cwd || os.homedir(),
        env: process.env,
        detached: true,
        stdio: 'ignore',
        shell: false,
        windowsHide: true
      })
    } catch (err) {
      return finish({
        ok: false,
        code: 'launcher_spawn_failed',
        message: `启动失败：${(err as Error).message}`
      })
    }

    const timer = setTimeout(() => {
      // 2s 内没有 error 就认为已经拉起来了；detached 子进程继续独立运行
      child.unref()
      finish({ ok: true, code: 'launcher_started' })
    }, options.timeoutMs ?? 2000)

    child.once('spawn', () => {
      child.unref()
      finish({ ok: true, code: 'launcher_started' })
    })
    child.once('error', (err) => {
      finish({
        ok: false,
        code: 'launcher_spawn_failed',
        message: `启动失败：${err.message}`
      })
    })
  })
}
