/**
 * ACP 会话封装（Agent Client Protocol，2026-10-23）。
 *
 * 只覆盖编码代理需要的标准面：
 *   initialize → session/new → session/prompt
 *   接收 session/update（消息/思考/工具调用）
 *   应答 session/request_permission（一次性允许/拒绝）
 *
 * 刻意不做：
 * - 不声明任何客户端能力（不提供文件读写、终端、elicitation）；
 * - 不挂 MCP（mcpServers 恒为空），避免模型通过 MCP 获得额外执行通道；
 * - 不做会话恢复/多会话：一个任务一个进程，结束即回收进程树。
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import readline from 'node:readline'
import { platform as osPlatform } from 'node:os'
import { JsonRpcConnection } from './jsonrpc'
import { toSpawnSpec, ACP_PROFILE_ARGS } from './command'

/** ACP 协议版本（v1） */
export const ACP_PROTOCOL_VERSION = 1

/**
 * 初始化/建会话的超时；prompt 不设单次超时（由上层任务总时限兜底）。
 * 首次在全新 DSH_HOME 上启动时要创建 profile/插件树，留足 60s。
 */
const HANDSHAKE_TIMEOUT_MS = 60_000
/** 结束会话时等待进程自行退出的宽限 */
const CLOSE_GRACE_MS = 3_000
/** stderr 只保留最后若干行，避免长任务吃内存 */
const STDERR_LIMIT = 40

export interface AcpUpdate {
  sessionUpdate: string
  [key: string]: unknown
}

export interface AcpPermissionOption {
  optionId: string
  name: string
  kind: string
}

export interface AcpPermissionRequest {
  sessionId: string
  toolCallId: string
  title: string
  /** ACP 工具类别：read/edit/execute/delete/... */
  kind: string
  /** 原始参数的人类可读摘要（由上层裁剪长度） */
  detail: string
  options: AcpPermissionOption[]
}

export type AcpPermissionDecision = 'allow' | 'reject'

export interface AcpSessionOptions {
  /** 已解析的可执行文件 */
  executable: string
  /** 可执行文件自身参数（不含 --profile acp） */
  baseArgs?: string[]
  cwd: string
  env?: NodeJS.ProcessEnv
  onUpdate?: (update: AcpUpdate) => void
  onPermission?: (request: AcpPermissionRequest) => Promise<AcpPermissionDecision>
  onStderr?: (line: string) => void
  onExit?: (info: { code: number | null; signal: NodeJS.Signals | null }) => void
  /** 注入用：测试可替换 spawn */
  spawnImpl?: typeof spawn
  platform?: NodeJS.Platform
}

/** 权限选项转可读文本（气泡展示用） */
export function describePermission(request: AcpPermissionRequest): string {
  const lines = [request.title || '编码代理请求执行一个操作']
  if (request.kind) lines.push(`类型：${request.kind}`)
  if (request.detail) lines.push(request.detail)
  return lines.join('\n')
}

/** 从参数里挑一次性允许选项；没有则视为不能允许（永不选 allow_always） */
export function pickAllowOption(options: AcpPermissionOption[]): AcpPermissionOption | null {
  return options.find((option) => option.kind === 'allow_once') ?? null
}

/**
 * 结束一个子进程树：
 * - Windows：taskkill /T /F（dsh.cmd → node 的父子链一起收）；
 * - POSIX：spawn 时已 detached，按进程组 kill。
 */
export function killProcessTree(
  pid: number | undefined,
  platform: NodeJS.Platform = osPlatform(),
  spawnImpl: typeof spawn = spawn
): void {
  if (!pid) return
  if (platform === 'win32') {
    try {
      spawnImpl('taskkill', ['/pid', String(pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore'
      }).unref()
    } catch {
      // 进程可能已经退出——忽略
    }
    return
  }
  try {
    process.kill(-pid, 'SIGKILL')
  } catch {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // 已退出
    }
  }
}

export class AcpSession extends EventEmitter {
  private readonly child: ChildProcess
  private readonly connection: JsonRpcConnection
  private readonly stderrLines: string[] = []
  private sessionIdValue: string | null = null
  private disposed = false
  private exitInfo: { code: number | null; signal: NodeJS.Signals | null } | null = null
  private readonly platform: NodeJS.Platform
  private readonly spawnImpl: typeof spawn

  private constructor(
    child: ChildProcess,
    connection: JsonRpcConnection,
    options: AcpSessionOptions
  ) {
    super()
    this.child = child
    this.connection = connection
    this.platform = options.platform ?? osPlatform()
    this.spawnImpl = options.spawnImpl ?? spawn

    // 子进程被强杀时管道会 EPIPE：吞掉流错误，别让主进程崩掉
    child.stdin?.on('error', () => {})
    child.stdout?.on('error', () => {})
    child.stderr?.on('error', () => {})

    child.on('exit', (code, signal) => {
      this.exitInfo = { code, signal }
      this.connection.dispose(
        new Error(
          `编码代理进程已退出（code=${String(code)}, signal=${String(signal)}）`
        )
      )
      try {
        options.onExit?.({ code, signal })
      } catch {
        // 回调异常不影响回收
      }
      this.emit('exit', { code, signal })
    })
  }

  get sessionId(): string {
    return this.sessionIdValue ?? ''
  }

  get stderrTail(): string[] {
    return [...this.stderrLines]
  }

  /** 由 stdout/stderr 读循环调用；保留最后 STDERR_LIMIT 行 */
  private pushStderr(line: string): void {
    if (!line) return
    this.stderrLines.push(line)
    if (this.stderrLines.length > STDERR_LIMIT) this.stderrLines.shift()
  }

  /** 进程退出的结构化信息（未退出为 null） */
  get exit(): { code: number | null; signal: NodeJS.Signals | null } | null {
    return this.exitInfo
  }

  /**
   * 启动子进程并完成 ACP 握手。
   * 失败时会自行回收进程，抛出的 Error 可直接展示给用户。
   */
  static async start(options: AcpSessionOptions): Promise<AcpSession> {
    const spawnImpl = options.spawnImpl ?? spawn
    const platform = options.platform ?? osPlatform()
    const spec = toSpawnSpec(
      options.executable,
      [...(options.baseArgs ?? []), ...ACP_PROFILE_ARGS],
      platform
    )

    const child = spawnImpl(spec.command, spec.args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      // POSIX 下建进程组，取消时整组回收
      detached: platform !== 'win32',
      shell: spec.shell
    })

    let session: AcpSession | null = null
    const connection = new JsonRpcConnection(
      {
        write: (line) => {
          if (!child.stdin || child.stdin.destroyed) {
            throw new Error('编码代理的输入流已关闭')
          }
          child.stdin.write(line + '\n')
        }
      },
      {
        onNotification: (method, params) => {
          if (method !== 'session/update') return
          const update = (params as { update?: AcpUpdate } | null)?.update
          if (update && typeof update.sessionUpdate === 'string') {
            options.onUpdate?.(update)
          }
        },
        onRequest: async (method, params) => {
          if (method !== 'session/request_permission') {
            throw new Error(`暂不支持编码代理的方法：${method}`)
          }
          const request = parsePermissionRequest(params)
          const decision = options.onPermission
            ? await options.onPermission(request)
            : 'reject'
          if (decision !== 'allow') return { outcome: { outcome: 'cancelled' } }
          const allow = pickAllowOption(request.options)
          if (!allow) return { outcome: { outcome: 'cancelled' } }
          return { outcome: { outcome: 'selected', optionId: allow.optionId } }
        },
        onError: (error) => options.onStderr?.(`[protocol] ${error.message}`)
      },
      HANDSHAKE_TIMEOUT_MS
    )

    if (child.stdout) {
      const outReader = readline.createInterface({ input: child.stdout })
      outReader.on('line', (line) => connection.accept(line))
    }

    session = new AcpSession(child, connection, { ...options, platform })

    // stderr 在 session 建好后再挂：读到的行要进 session 自己的环形缓冲，
    // 启动失败时才能把最后几行带进错误信息。
    if (child.stderr) {
      const errReader = readline.createInterface({ input: child.stderr })
      errReader.on('line', (line) => {
        session?.pushStderr(line)
        options.onStderr?.(line)
      })
    }

    const startupError = await new Promise<Error | null>((resolve) => {
      let settled = false
      const finish = (error: Error | null): void => {
        if (settled) return
        settled = true
        resolve(error)
      }
      child.once('error', (error) => finish(error))
      void (async () => {
        try {
          await connection.request('initialize', {
            protocolVersion: ACP_PROTOCOL_VERSION,
            clientCapabilities: {}
          })
          const created = (await connection.request('session/new', {
            cwd: options.cwd,
            mcpServers: []
          })) as { sessionId?: unknown } | null
          const id = created?.sessionId
          if (typeof id !== 'string' || !id) {
            throw new Error('编码代理没有返回会话 id')
          }
          session!.sessionIdValue = id
          finish(null)
        } catch (error) {
          finish(error instanceof Error ? error : new Error(String(error)))
        }
      })()
    })

    if (startupError) {
      await session.dispose()
      const tail = session.stderrTail.slice(-5).join('\n')
      const message = tail ? `${startupError.message}\n${tail}` : startupError.message
      throw new Error(message)
    }
    return session
  }

  /** 发送任务并等待本轮结束；stopReason 原样返回 */
  async prompt(task: string): Promise<{ stopReason: string }> {
    if (!this.sessionIdValue) throw new Error('编码代理会话尚未建立')
    const result = (await this.connection.request(
      'session/prompt',
      {
        sessionId: this.sessionIdValue,
        prompt: [{ type: 'text', text: task }]
      },
      0
    )) as { stopReason?: unknown } | null
    const stopReason =
      typeof result?.stopReason === 'string' ? result.stopReason : 'unknown'
    return { stopReason }
  }

  /** 请求中止（通知；进程回收仍以 dispose 为准） */
  cancel(): void {
    if (!this.sessionIdValue || this.disposed) return
    try {
      this.connection.notify('session/cancel', { sessionId: this.sessionIdValue })
    } catch {
      // 连接已断——交给 dispose
    }
  }

  /** 关闭会话并回收进程树（幂等） */
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true

    if (this.sessionIdValue) {
      try {
        await this.connection.request(
          'session/close',
          { sessionId: this.sessionIdValue },
          CLOSE_GRACE_MS
        )
      } catch {
        // 不支持/已断开：继续走进程回收
      }
    }

    try {
      this.child.stdin?.end()
    } catch {
      // 忽略
    }

    // 进程根本没起来（spawn ENOENT）时不会有 exit 事件，直接结束
    if (this.exitInfo === null && this.child.pid) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          killProcessTree(this.child.pid, this.platform, this.spawnImpl)
          resolve()
        }, CLOSE_GRACE_MS)
        this.child.once('exit', () => {
          clearTimeout(timer)
          resolve()
        })
      })
    }
    this.connection.dispose(new Error('会话已关闭'))
  }
}

/** 解析权限请求参数；形状不符时给保守默认值（拒绝由上层决定） */
export function parsePermissionRequest(params: unknown): AcpPermissionRequest {
  const raw = (params ?? {}) as Record<string, unknown>
  const toolCall = (raw.toolCall ?? {}) as Record<string, unknown>
  const optionsRaw = Array.isArray(raw.options) ? raw.options : []
  const options: AcpPermissionOption[] = []
  for (const item of optionsRaw) {
    if (!item || typeof item !== 'object') continue
    const option = item as Record<string, unknown>
    const optionId = typeof option.optionId === 'string' ? option.optionId : ''
    if (!optionId) continue
    options.push({
      optionId,
      name: typeof option.name === 'string' ? option.name : optionId,
      kind: typeof option.kind === 'string' ? option.kind : 'other'
    })
  }
  return {
    sessionId: typeof raw.sessionId === 'string' ? raw.sessionId : '',
    toolCallId: typeof toolCall.toolCallId === 'string' ? toolCall.toolCallId : '',
    title: typeof toolCall.title === 'string' ? toolCall.title : '',
    kind: typeof toolCall.kind === 'string' ? toolCall.kind : '',
    detail: summarizeRawInput(toolCall.rawInput),
    options
  }
}

/** 把 rawInput 压成一行可读摘要（气泡展示用；不做任意深度展开） */
export function summarizeRawInput(raw: unknown, limit = 300): string {
  if (raw === undefined || raw === null) return ''
  let text: string
  if (typeof raw === 'string') {
    text = raw
  } else {
    try {
      text = JSON.stringify(raw)
    } catch {
      text = String(raw)
    }
  }
  text = text.replace(/\s+/g, ' ').trim()
  return text.length > limit ? `${text.slice(0, limit)}…` : text
}
