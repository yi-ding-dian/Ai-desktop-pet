/**
 * Python 子进程域：spawn / READY 握手 / 存活监控与重启 / 退出清理（设计文档 §5.2）。
 *
 * 状态机：starting → ready →（异常退出）重试启动 → ready / failed；主动 stop → stopped。
 * 与渲染进程的 IPC：backend:status-changed（状态）+ backend:ready（port/token）。
 * 高内聚约定：整个项目只有本目录直接管理 Python 进程（窗口/IPC 域不得绕过）。
 */
import { app, BrowserWindow } from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createInterface } from 'node:readline'
import {
  IPC_EVENTS,
  type BackendReadyPayload,
  type BackendSnapshot,
  type BackendState,
  type BackendStatusPayload
} from '../ipc/channels'
import { locateBackend, type BackendLaunchSpec } from './locate'

/** READY 握手行前缀（与 backend/main.py 的 READY_PREFIX 对齐） */
const READY_PREFIX = 'PET_READY '
/** READY 握手超时（任务约定 15s 未就绪 = 失败） */
const READY_TIMEOUT_MS = 15_000
/** 崩溃自动重启上限（简单版：连续失败 3 次后置 failed） */
const MAX_RESTARTS = 3
/** SIGTERM 后等待优雅退出的时间，超时 SIGKILL（防僵尸） */
const TERM_GRACE_MS = 3_000

/** READY 行载荷（backend/main.py emit_ready；开发模式自测时才有 token 字段） */
interface ReadyPayload {
  port: number
  pid: number
  token?: string
}

export class BackendProcessManager {
  private child: ChildProcess | null = null
  private spec: BackendLaunchSpec | null = null
  private state: BackendState = 'starting'
  private message: string | undefined
  private port: number | undefined
  private token: string | undefined
  private pid: number | undefined
  /** 主动停止标志：置位后不再自动重启 */
  private stopping = false
  /** 连续启动/崩溃失败次数（ready 后清零） */
  private restarts = 0
  private readyTimer: NodeJS.Timeout | null = null
  private restartTimer: NodeJS.Timeout | null = null

  /** 启动（或崩溃后重试启动）后端进程；幂等保护：已有存活进程时不重复 spawn */
  start(): void {
    if (this.stopping) return
    if (this.child !== null) return
    this.clearReadyTimer()

    if (!this.spec) {
      try {
        this.spec = locateBackend()
      } catch (err) {
        this.setState('failed', `后端定位失败：${(err as Error).message}`)
        return
      }
    }

    // token 每次启动随机生成（32 字节 hex），经 env 传给 Python（设计文档 §3.4）
    this.token = randomBytes(32).toString('hex')
    let child: ChildProcess
    try {
      child = spawn(this.spec.command, this.spec.args, {
        cwd: this.spec.cwd,
        env: {
          ...process.env,
          PET_TOKEN: this.token,
          PET_DATA_DIR: app.getPath('userData'),
          // 运行模式标记（后端当前未消费，按设计文档 §3.4 预留）
          PET_MODE: app.isPackaged ? 'prod' : 'dev'
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
      })
    } catch (err) {
      this.onSpawnFailed(err as Error)
      return
    }

    this.child = child
    this.pid = child.pid
    this.setState('starting', `${this.restarts > 0 ? `第 ${this.restarts} 次重启中：` : ''}${this.spec.label}`)
    console.log(`[backend] 已拉起子进程 pid=${child.pid}：${this.spec.label}`)

    // stdout：唯一合法输出是 READY 握手行，其余行记录为可疑输出（任务约定）
    const stdoutRl = createInterface({ input: child.stdout! })
    stdoutRl.on('line', (line) => this.onStdoutLine(line))
    // stderr：后端日志（loguru）全走这里，逐行转发到主进程日志
    const stderrRl = createInterface({ input: child.stderr! })
    stderrRl.on('line', (line) => console.log(`[backend] ${line}`))

    child.on('error', (err) => {
      console.error(`[backend] 子进程错误：${err.message}`)
      // spawn 失败（如 ENOENT）不会触发 exit 事件：这里兜底走失败/重启流程
      if (this.child === child) {
        this.child = null
        this.onSpawnFailed(err)
      }
    })
    child.on('exit', (code, signal) => this.onExit(code, signal))

    // READY 握手超时：15s 未就绪视为启动失败（kill 触发 exit → 走重启逻辑）
    this.readyTimer = setTimeout(() => {
      this.readyTimer = null
      if (this.state === 'ready' || this.child !== child) return
      console.error(`[backend] READY 握手超时（${READY_TIMEOUT_MS / 1000}s），终止并重启`)
      child.kill('SIGKILL')
    }, READY_TIMEOUT_MS)
  }

  /** 主动停止：SIGTERM → 3s → SIGKILL；供 app 退出清理调用 */
  async stop(): Promise<void> {
    this.stopping = true
    this.clearReadyTimer()
    if (this.restartTimer) {
      clearTimeout(this.restartTimer)
      this.restartTimer = null
    }
    const child = this.child
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      this.child = null
      this.setState('stopped')
      return
    }
    console.log(`[backend] 正在停止子进程 pid=${child.pid}（SIGTERM，3s 宽限）`)
    await this.killChild(child)
    this.child = null
    this.setState('stopped')
  }

  /** 当前状态快照（IPC invoke 应答） */
  getSnapshot(): BackendSnapshot {
    return {
      state: this.state,
      message: this.message,
      port: this.state === 'ready' ? this.port : undefined,
      token: this.state === 'ready' ? this.token : undefined,
      pid: this.pid,
      appVersion: app.getVersion()
    }
  }

  // ---------------- 内部实现 ----------------

  private onStdoutLine(line: string): void {
    if (line.startsWith(READY_PREFIX)) {
      this.onReadyLine(line)
      return
    }
    // stdout 只应出现 READY 一行；其余输出可疑（协议约定），记日志但不致命
    console.warn(`[backend] stdout 可疑输出（协议约定 stdout 只有 PET_READY）: ${line}`)
  }

  private onReadyLine(line: string): void {
    let payload: ReadyPayload
    try {
      payload = JSON.parse(line.slice(READY_PREFIX.length)) as ReadyPayload
    } catch (err) {
      console.error(`[backend] PET_READY 行解析失败：${line}（${(err as Error).message}）`)
      return
    }
    if (this.readyTimer) {
      clearTimeout(this.readyTimer)
      this.readyTimer = null
    }
    this.restarts = 0
    this.port = payload.port
    this.pid = payload.pid
    this.setState('ready', `127.0.0.1:${payload.port} pid=${payload.pid}`)

    const ready: BackendReadyPayload = {
      port: payload.port,
      token: this.token!,
      pid: payload.pid,
      appVersion: app.getVersion()
    }
    this.broadcast(IPC_EVENTS.BACKEND_READY, ready)
  }

  private onExit(code: number | null, signal: NodeJS.Signals | null): void {
    this.child = null
    this.clearReadyTimer()
    if (this.stopping) {
      console.log(`[backend] 后端进程已退出（code=${code} signal=${signal}）`)
      // 状态由 stop() 收尾置为 stopped，这里不重复广播
      return
    }
    const reason = `后端进程异常退出（code=${code} signal=${signal}）`
    console.error(`[backend] ${reason}`)
    if (this.restarts < MAX_RESTARTS) {
      this.restarts += 1
      const delay = 1000 * 2 ** (this.restarts - 1) // 1s → 2s → 4s
      this.setState('starting', `${reason}，${delay / 1000}s 后重启（第 ${this.restarts}/${MAX_RESTARTS} 次）`)
      this.restartTimer = setTimeout(() => {
        this.restartTimer = null
        this.start()
      }, delay)
    } else {
      this.setState('failed', `${reason}，已达最大重启次数（${MAX_RESTARTS}），请重启应用`)
    }
  }

  private onSpawnFailed(err: Error): void {
    if (this.stopping) return
    if (this.restarts < MAX_RESTARTS) {
      this.restarts += 1
      const delay = 1000 * 2 ** (this.restarts - 1)
      this.setState('starting', `子进程拉起失败（${err.message}），${delay / 1000}s 后重试（第 ${this.restarts}/${MAX_RESTARTS} 次）`)
      this.restartTimer = setTimeout(() => {
        this.restartTimer = null
        this.start()
      }, delay)
    } else {
      this.setState('failed', `子进程拉起失败：${err.message}`)
    }
  }

  /** SIGTERM → 宽限 3s → SIGKILL；exit 未等到时也不阻塞退出流程（兜底超时） */
  private killChild(child: ChildProcess): Promise<void> {
    return new Promise((resolveDone) => {
      let done = false
      const finish = (): void => {
        if (done) return
        done = true
        resolveDone()
      }
      child.once('exit', () => finish())
      child.kill('SIGTERM')
      setTimeout(() => {
        if (done) return
        console.warn('[backend] SIGTERM 3s 内未退出，发送 SIGKILL')
        child.kill('SIGKILL')
      }, TERM_GRACE_MS)
      // 兜底：即使 exit 事件迟迟不来（极端情况），也不卡死应用退出
      setTimeout(finish, TERM_GRACE_MS + 1500)
    })
  }

  private setState(state: BackendState, message?: string): void {
    this.state = state
    this.message = message
    console.log(`[backend] 状态 -> ${state}${message ? `（${message}）` : ''}`)
    const payload: BackendStatusPayload = { state, message }
    this.broadcast(IPC_EVENTS.BACKEND_STATUS_CHANGED, payload)
  }

  private broadcast(channel: string, payload: unknown): void {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send(channel, payload)
      }
    }
  }

  private clearReadyTimer(): void {
    if (this.readyTimer) {
      clearTimeout(this.readyTimer)
      this.readyTimer = null
    }
  }
}

/** 单例：进程管理只此一份（main.ts 启动，ipc 域查询快照） */
export const backendManager = new BackendProcessManager()
