/**
 * 极简 JSON-RPC 2.0 客户端（2026-10-23 编码代理接入）。
 *
 * 只实现 ACP 需要的三件事：发请求（带超时）、发通知、应答对方发来的请求
 * （`session/request_permission`）。不引入 `@agentclientprotocol/sdk`：
 * 依赖越少，打包越稳；协议本身只是 newline-delimited JSON。
 *
 * 分帧由调用方负责（每行一个完整 JSON 对象），本类只做解析与派发。
 */

export interface JsonRpcErrorShape {
  code: number
  message: string
  data?: unknown
}

interface PendingCall {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout | null
  method: string
}

export interface JsonRpcHandlers {
  /** 对方发来的请求（有 method + id）：返回值会作为 result 回写；抛错回 -32603 */
  onRequest?: (method: string, params: unknown) => Promise<unknown> | unknown
  /** 对方发来的通知（有 method、无 id） */
  onNotification?: (method: string, params: unknown) => void
  /** 解析失败/协议异常（不终端连接，交由上层记日志） */
  onError?: (error: Error) => void
}

/** 传输层：实际写一行（含换行由实现决定） */
export interface JsonRpcTransport {
  write(line: string): void
}

export class JsonRpcCallError extends Error {
  readonly code: number
  readonly data: unknown

  constructor(error: JsonRpcErrorShape) {
    super(error.message || `JSON-RPC 错误 ${error.code}`)
    this.name = 'JsonRpcCallError'
    this.code = error.code
    this.data = error.data
  }
}

/** 一次 RPC 调用的默认超时（毫秒）；长任务由调用方显式传 0 关闭 */
export const DEFAULT_RPC_TIMEOUT_MS = 30_000

export class JsonRpcConnection {
  private seq = 0
  private readonly pending = new Map<number, PendingCall>()
  private closed = false
  private closedReason: Error | null = null

  constructor(
    private readonly transport: JsonRpcTransport,
    private readonly handlers: JsonRpcHandlers = {},
    private readonly defaultTimeoutMs = DEFAULT_RPC_TIMEOUT_MS
  ) {}

  /** 发请求；timeoutMs<=0 表示不设超时（任务级调用由上层总超时兜底） */
  request(method: string, params?: unknown, timeoutMs?: number): Promise<unknown> {
    if (this.closed) return Promise.reject(this.closedReason ?? new Error('连接已关闭'))
    const id = ++this.seq
    const timeout = timeoutMs ?? this.defaultTimeoutMs
    return new Promise((resolve, reject) => {
      const timer =
        timeout > 0
          ? setTimeout(() => {
              this.pending.delete(id)
              reject(new Error(`等待 ${method} 响应超时（${timeout}ms）`))
            }, timeout)
          : null
      this.pending.set(id, { resolve, reject, timer, method })
      try {
        this.send({ jsonrpc: '2.0', id, method, params })
      } catch (err) {
        this.pending.delete(id)
        if (timer) clearTimeout(timer)
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    })
  }

  /** 发通知（不带 id，不等待响应） */
  notify(method: string, params?: unknown): void {
    if (this.closed) return
    this.send({ jsonrpc: '2.0', method, params })
  }

  /** 送入一行原始文本（stdout 的一行）；空行忽略 */
  accept(line: string): void {
    const text = line.trim()
    if (!text) return
    let message: unknown
    try {
      message = JSON.parse(text)
    } catch {
      this.handlers.onError?.(new Error(`收到非 JSON 输出：${text.slice(0, 200)}`))
      return
    }
    if (typeof message !== 'object' || message === null) {
      this.handlers.onError?.(new Error('收到非对象 JSON-RPC 消息'))
      return
    }
    this.dispatch(message as Record<string, unknown>)
  }

  /** 连接终止：拒绝所有在途请求；之后的调用立即失败 */
  dispose(reason: Error): void {
    if (this.closed) return
    this.closed = true
    this.closedReason = reason
    for (const [id, call] of this.pending) {
      if (call.timer) clearTimeout(call.timer)
      call.reject(new Error(`${reason.message}（未完成的 ${call.method}）`))
      this.pending.delete(id)
    }
  }

  get isClosed(): boolean {
    return this.closed
  }

  // ---------------------------------------------------------------- 内部

  private send(payload: Record<string, unknown>): void {
    this.transport.write(JSON.stringify(payload))
  }

  private dispatch(message: Record<string, unknown>): void {
    const id = message.id
    const method = message.method

    // 响应：有 id、无 method
    if (method === undefined) {
      if (typeof id !== 'number') {
        this.handlers.onError?.(new Error('收到缺少 method 且 id 非法的消息'))
        return
      }
      const call = this.pending.get(id)
      if (!call) {
        // 超时后迟到的响应：丢弃即可，不算协议错误
        return
      }
      this.pending.delete(id)
      if (call.timer) clearTimeout(call.timer)
      const error = message.error
      if (error && typeof error === 'object') {
        call.reject(new JsonRpcCallError(error as JsonRpcErrorShape))
        return
      }
      call.resolve(message.result)
      return
    }

    // 通知：有 method、无 id
    if (id === undefined) {
      if (typeof method !== 'string') {
        this.handlers.onError?.(new Error('通知的 method 不是字符串'))
        return
      }
      try {
        this.handlers.onNotification?.(method, message.params)
      } catch (err) {
        this.handlers.onError?.(err instanceof Error ? err : new Error(String(err)))
      }
      return
    }

    // 请求：有 method、有 id
    if (typeof method !== 'string') {
      this.replyError(id, -32600, 'method 必须是字符串')
      return
    }
    void this.handleRequest(id, method, message.params)
  }

  private async handleRequest(id: unknown, method: string, params: unknown): Promise<void> {
    const handler = this.handlers.onRequest
    if (!handler) {
      this.replyError(id, -32601, `不支持的方法：${method}`)
      return
    }
    try {
      const result = await handler(method, params)
      this.send({ jsonrpc: '2.0', id, result: result ?? null })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.replyError(id, -32603, message)
    }
  }

  private replyError(id: unknown, code: number, message: string): void {
    if (this.closed) return
    this.send({ jsonrpc: '2.0', id, error: { code, message } })
  }
}
