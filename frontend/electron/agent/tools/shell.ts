/** 命令执行：环境白名单、输出解码、超时与进程树回收。 */
import { spawn } from 'node:child_process'

export const BASH_OUTPUT_LIMIT = 200_000

export const BASH_DEFAULT_TIMEOUT = 120_000
export const BASH_MAX_TIMEOUT = 600_000

/** 命令行环境白名单：不放任何 Key / Token（含宠物自身的） */
function cleanEnv(): NodeJS.ProcessEnv {
  const keep = [
    'PATH',
    'Path',
    'PATHEXT',
    'SystemRoot',
    'windir',
    'COMSPEC',
    'ComSpec',
    'TEMP',
    'TMP',
    'HOME',
    'USERPROFILE',
    'APPDATA',
    'LOCALAPPDATA',
    'NUMBER_OF_PROCESSORS',
    'OS',
    'PROCESSOR_ARCHITECTURE',
    'LANG',
    'LC_ALL',
    'TERM',
    'SHELL',
    'USER'
  ]
  const env: NodeJS.ProcessEnv = {}
  for (const key of keep) {
    const value = process.env[key]
    if (value !== undefined) env[key] = value
  }
  return env
}

/**
 * 控制台输出解码：先按 UTF-8，出现替换字符再按 GBK 解。
 *
 * 中文 Windows 的 cmd 内建命令（dir 等）按 OEM 代码页输出 GBK 字节，
 * 直接按 UTF-8 解会得到「������ C �еľ���」这类乱码，模型看不懂就会反复重试。
 */
function decodeOutput(buf: Buffer): string {
  if (buf.length === 0) return ''
  const utf8 = new TextDecoder('utf-8').decode(buf)
  if (!utf8.includes('�')) return utf8
  try {
    return new TextDecoder('gbk').decode(buf)
  } catch {
    return utf8
  }
}

/** 回收整棵进程树（Windows 用 taskkill /T，POSIX 用进程组） */
export function killProcessTree(pid: number | undefined): void {
  if (!pid) return
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }).on(
        'error',
        () => undefined
      )
    } catch {
      /* 进程可能已退出 */
    }
    return
  }
  try {
    process.kill(-pid, 'SIGKILL')
  } catch {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      /* 已退出 */
    }
  }
}

interface CommandResult {
  output: string
  code: number | null
  timedOut: boolean
  aborted: boolean
}

/** 执行一条命令：cwd 锁工作区、环境白名单、超时与输出上限、结束回收进程树 */
export function runCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<CommandResult> {
  return new Promise((resolve) => {
    const isWin = process.platform === 'win32'
    // 用 shell:true 交给 Node 处理引号：显式传 ["/d","/s","/c", command] 时
    // libuv 会给带空格的参数整体加引号，cmd 的引号剥离规则会把 `node -e "..."` 这类
    // 命令吃掉（静默无输出）。POSIX 侧 detached 让整组子进程可一次性回收。
    const child = spawn(command, {
      cwd,
      env: cleanEnv(),
      windowsHide: true,
      shell: true,
      detached: !isWin
    })

    // 保留原始字节，结束时再统一解码：中文 Windows 的控制台输出常是 GBK，
    // 边收边按 UTF-8 解会变成乱码，模型读不懂就会不停重试。
    const headChunks: Buffer[] = []
    const tailChunks: Buffer[] = []
    const headLimit = Math.floor(BASH_OUTPUT_LIMIT * 0.75)
    const tailLimit = Math.floor(BASH_OUTPUT_LIMIT * 0.25)
    let headBytes = 0
    let tailBytes = 0
    let totalBytes = 0
    let timedOut = false
    let aborted = false
    let settled = false

    const append = (chunk: Buffer): void => {
      totalBytes += chunk.length
      if (headBytes < headLimit) {
        const room = headLimit - headBytes
        if (chunk.length <= room) {
          headChunks.push(chunk)
          headBytes += chunk.length
          return
        }
        headChunks.push(chunk.subarray(0, room))
        headBytes += room
        chunk = chunk.subarray(room)
      }
      tailChunks.push(chunk)
      tailBytes += chunk.length
      while (tailBytes > tailLimit && tailChunks.length > 1) {
        const dropped = tailChunks.shift()!
        tailBytes -= dropped.length
      }
    }

    child.stdout?.on('data', append)
    child.stderr?.on('data', append)

    const kill = (why: 'timeout' | 'abort'): void => {
      if (why === 'timeout') timedOut = true
      else aborted = true
      killProcessTree(child.pid)
    }

    const timer = setTimeout(() => kill('timeout'), timeoutMs)
    const onAbort = (): void => kill('abort')
    signal?.addEventListener('abort', onAbort, { once: true })

    const finish = (code: number | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      const head = decodeOutput(Buffer.concat(headChunks))
      const kept = headBytes + tailBytes
      const output =
        totalBytes > kept
          ? `${head}\n…（输出过长已截断，共 ${totalBytes} 字节）…\n${decodeOutput(Buffer.concat(tailChunks))}`
          : head
      resolve({ output: output.trim(), code, timedOut, aborted })
    }

    child.on('error', () => finish(null))
    child.on('close', (code) => finish(code))
  })
}
