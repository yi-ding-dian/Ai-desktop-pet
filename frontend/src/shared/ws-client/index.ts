/**
 * WS 客户端 SDK（设计文档 §5.5）：连接管理（重连/心跳）+ 事件分发（type → 订阅者）+ 二进制音频帧分帧。
 *
 * 运行在渲染进程：只用浏览器原生 WebSocket（无 Node ws 库）。
 * URL 由主进程经 pet-bridge 下发（见 ./bridge.ts），本文件不感知 IPC。
 * 二进制帧（§3.5 音频）解析见 ./binary-frame.ts，派发为 `audio` 事件（订阅者拿到 {header, payload}）。
 */
import {
  PROTOCOL_VERSION,
  serializeEnvelope,
  type AudioFramePacket,
  type ClientEventMap,
  type ClientEventType,
  type Envelope,
  type HelloAckData,
  type ServerEventMap,
  type ServerEventType
} from '../protocol'
import { parseAudioFrame } from './binary-frame'

/** 连接生命周期状态（供 UI 展示） */
export type WsConnectionState =
  | 'idle' // 未开始（等待主进程下发后端 ready）
  | 'connecting' // WS 建连中
  | 'authenticating' // 已发 hello，等 hello_ack
  | 'connected' // hello_ack ok
  | 'reconnecting' // 断开后在退避等待
  | 'auth-failed' // hello_ack ok=false / fatal 错误（不再自动重连）
  | 'closed' // 手动断开（后端停止等）

/** 连接目标（由 bridge 从主进程 ready 事件获得） */
export interface WsTarget {
  /** ws://127.0.0.1:<port>/ws */
  url: string
  /** hello 鉴权 token（主进程随机生成，每次后端启动不同） */
  token: string
  /** 应用版本（hello.app_version，做版本握手） */
  appVersion: string
}

export interface WsClientOptions {
  /** 心跳间隔（默认 30s，设计文档 §3.6） */
  pingIntervalMs?: number
  /** pong 超时（默认 10s，超时判死并重连） */
  pongTimeoutMs?: number
  /** 重连退避起始（默认 1s，封顶 30s） */
  reconnectBaseMs?: number
  /** 重连退避封顶（默认 30s） */
  reconnectMaxMs?: number
}

/**
 * 事件处理器：数据载荷 + 原始信封（reply_to 等配对信息在信封里）。
 * 二进制帧（audio）没有信封 → envelope 为 null。
 */
type EventHandler<T> = (data: T, envelope: Envelope | null) => void

export class WsClient {
  private ws: WebSocket | null = null
  private target: WsTarget | null = null
  private state: WsConnectionState = 'idle'
  private readonly handlers = new Map<string, Set<EventHandler<never>>>()
  private readonly stateHandlers = new Set<(state: WsConnectionState) => void>()

  private reconnectAttempt = 0
  private reconnectTimer: number | null = null
  private pingTimer: number | null = null
  private pongTimer: number | null = null
  /** 已发 ping 未收到 pong */
  private awaitingPong = false
  /** 手动断开标志：置位后不再自动重连 */
  private manualClose = false
  /** 音频帧无订阅者只警告一次（避免每帧刷日志） */
  private warnedNoAudioSubscriber = false

  private readonly pingIntervalMs: number
  private readonly pongTimeoutMs: number
  private readonly reconnectBaseMs: number
  private readonly reconnectMaxMs: number

  constructor(options: WsClientOptions = {}) {
    this.pingIntervalMs = options.pingIntervalMs ?? 30_000
    this.pongTimeoutMs = options.pongTimeoutMs ?? 10_000
    this.reconnectBaseMs = options.reconnectBaseMs ?? 1_000
    this.reconnectMaxMs = options.reconnectMaxMs ?? 30_000
  }

  get connectionState(): WsConnectionState {
    return this.state
  }

  /** 建立（或重建）连接；相同目标且连接尚在时幂等忽略 */
  connect(target: WsTarget): void {
    const sameTarget =
      this.target !== null && this.target.url === target.url && this.target.token === target.token
    const active =
      this.state === 'connecting' ||
      this.state === 'authenticating' ||
      this.state === 'connected' ||
      this.state === 'auth-failed'
    if (sameTarget && active) return

    this.target = target
    this.manualClose = false
    this.reconnectAttempt = 0
    this.clearReconnectTimer()
    this.open()
  }

  /** 手动断开：不再自动重连（后端 stopped / failed 时由 bridge 调用） */
  disconnect(): void {
    this.manualClose = true
    this.clearReconnectTimer()
    this.clearHeartbeat()
    this.closeSocket()
    this.setState('closed')
  }

  /** 发送一条客户端事件；未连接时返回 false */
  send<T extends ClientEventType>(type: T, data: ClientEventMap[T]): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || this.state !== 'connected') {
      console.warn(`[ws] 连接未就绪，未发送 ${type}（state=${this.state}）`)
      return false
    }
    this.ws.send(serializeEnvelope(type, data))
    return true
  }

  /** 订阅某类服务端事件；返回取消订阅函数 */
  on<T extends ServerEventType>(type: T, handler: EventHandler<ServerEventMap[T]>): () => void {
    let set = this.handlers.get(type)
    if (!set) {
      set = new Set()
      this.handlers.set(type, set)
    }
    set.add(handler as EventHandler<never>)
    return () => {
      set!.delete(handler as EventHandler<never>)
    }
  }

  /** 订阅连接状态变化；返回取消订阅函数 */
  onStateChange(handler: (state: WsConnectionState) => void): () => void {
    this.stateHandlers.add(handler)
    return () => {
      this.stateHandlers.delete(handler)
    }
  }

  // ---------------- 内部实现 ----------------

  private open(): void {
    const target = this.target
    if (!target) return
    this.closeSocket()
    this.clearHeartbeat()
    this.setState(this.reconnectAttempt > 0 ? 'reconnecting' : 'connecting')

    let ws: WebSocket
    try {
      ws = new WebSocket(target.url)
    } catch (err) {
      console.error(`[ws] 建连失败：${(err as Error).message}`)
      this.scheduleReconnect()
      return
    }
    this.ws = ws

    // 二进制帧按 ArrayBuffer 交付（§3.5 音频帧解析依赖；浏览器默认是 'blob'）
    ws.binaryType = 'arraybuffer'

    ws.onopen = (): void => {
      if (ws !== this.ws) return
      console.log(`[ws] 已连接 ${target.url}，发送 hello（app_version=${target.appVersion}）`)
      this.setState('authenticating')
      this.rawSend(
        serializeEnvelope('hello', {
          token: target.token,
          protocol_version: PROTOCOL_VERSION,
          app_version: target.appVersion
        })
      )
    }

    ws.onmessage = (event: MessageEvent): void => {
      if (ws !== this.ws) return
      this.handleMessage(event.data)
    }

    ws.onclose = (): void => {
      if (ws !== this.ws) return
      this.ws = null
      this.clearHeartbeat()
      if (this.manualClose) {
        this.setState('closed')
        return
      }
      if (this.state === 'auth-failed') return // 鉴权失败不重试（重连无意义）
      this.scheduleReconnect()
    }

    ws.onerror = (): void => {
      // 浏览器规范：error 后必随 close，重连逻辑统一在 onclose
      if (ws === this.ws) console.warn('[ws] 连接错误（将按 close 流程处理）')
    }
  }

  private rawSend(raw: string): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(raw)
    }
  }

  private handleMessage(raw: unknown): void {
    // 二进制帧（§3.5 音频）：binaryType='arraybuffer'，走独立解析/派发路径
    if (raw instanceof ArrayBuffer) {
      this.handleBinaryFrame(raw)
      return
    }
    if (typeof raw !== 'string') {
      // 未知类型兜底（如 binaryType 被改回 'blob'）：忽略但不崩
      console.warn('[ws] 收到未知类型帧，已忽略:', Object.prototype.toString.call(raw))
      return
    }
    let envelope: Envelope
    try {
      envelope = JSON.parse(raw) as Envelope
    } catch {
      console.warn('[ws] 收到非 JSON 帧，已忽略:', raw)
      return
    }

    // hello_ack 先决处理：驱动连接状态机与心跳
    if (envelope.type === 'hello_ack') {
      const data = envelope.data as HelloAckData
      if (data.ok) {
        this.reconnectAttempt = 0
        this.setState('connected')
        this.startHeartbeat()
        console.log(
          `[ws] hello_ack ok=true session=${data.session_id ?? '-'} server_version=${data.server_version}`
        )
      } else {
        console.error('[ws] hello_ack ok=false：鉴权/版本握手失败（详见随后的 error 事件）')
        this.setState('auth-failed')
      }
    }
    if (envelope.type === 'pong') {
      this.awaitingPong = false
      if (this.pongTimer !== null) {
        clearTimeout(this.pongTimer)
        this.pongTimer = null
      }
    }
    // audio 必须走二进制帧（§3.5）：文本帧出现 audio 属异常（如旧后端占位事件），忽略而非误派发
    if (envelope.type === 'audio') {
      console.warn('[ws] 收到文本帧 audio（应为二进制帧，见设计文档 §3.5），已忽略')
      return
    }
    this.dispatch(envelope)
  }

  /**
   * 二进制帧处理（§3.5）：解析出 {header, payload} 后派发给 `audio` 订阅者（voice 域）。
   * 坏帧由 parseAudioFrame 记日志并返回 null，连接与后续帧不受影响。
   */
  private handleBinaryFrame(buf: ArrayBuffer): void {
    const packet = parseAudioFrame(buf)
    if (!packet) return
    const set = this.handlers.get('audio')
    if (!set || set.size === 0) {
      if (!this.warnedNoAudioSubscriber) {
        this.warnedNoAudioSubscriber = true
        console.warn('[ws] 收到音频帧但无订阅者（voice 域未接线？），已忽略')
      }
      return
    }
    for (const handler of set) {
      try {
        ;(handler as EventHandler<AudioFramePacket>)(packet, null)
      } catch (err) {
        console.error('[ws] audio 帧订阅者抛错：', err)
      }
    }
  }

  private dispatch(envelope: Envelope): void {
    const set = this.handlers.get(envelope.type)
    if (!set || set.size === 0) return
    for (const handler of set) {
      try {
        ;(handler as EventHandler<unknown>)(envelope.data, envelope)
      } catch (err) {
        console.error(`[ws] 事件 ${envelope.type} 的订阅者抛错：`, err)
      }
    }
  }

  // ---------------- 心跳（30s ping / 10s 无 pong 判死，§3.6） ----------------

  private startHeartbeat(): void {
    this.clearHeartbeat()
    this.pingTimer = window.setInterval(() => {
      if (!this.ws || this.state !== 'connected') return
      if (this.awaitingPong) return // 上一轮未回：等 pong 超时定时器判死
      this.awaitingPong = true
      this.rawSend(serializeEnvelope('ping', {}))
      this.pongTimer = window.setTimeout(() => {
        this.pongTimer = null
        if (!this.awaitingPong) return
        console.warn(`[ws] ${this.pongTimeoutMs / 1000}s 无 pong，判定连接已死，重连`)
        this.awaitingPong = false
        this.forceReconnect()
      }, this.pongTimeoutMs)
    }, this.pingIntervalMs)
  }

  private clearHeartbeat(): void {
    if (this.pingTimer !== null) {
      clearInterval(this.pingTimer)
      this.pingTimer = null
    }
    if (this.pongTimer !== null) {
      clearTimeout(this.pongTimer)
      this.pongTimer = null
    }
    this.awaitingPong = false
  }

  // ---------------- 重连（指数退避，§3.6：1s → 2s → … → 30s 封顶） ----------------

  private forceReconnect(): void {
    const ws = this.ws
    this.ws = null
    if (ws) {
      ws.onclose = null // 防止旧 socket 的 close 再触发一次重连调度
      try {
        ws.close()
      } catch {
        /* 已断开 */
      }
    }
    this.clearHeartbeat()
    this.scheduleReconnect()
  }

  private scheduleReconnect(): void {
    if (this.manualClose) return
    if (this.reconnectTimer !== null) return
    this.reconnectAttempt += 1
    const delay = Math.min(
      this.reconnectBaseMs * 2 ** (this.reconnectAttempt - 1),
      this.reconnectMaxMs
    )
    console.warn(`[ws] ${delay / 1000}s 后重连（第 ${this.reconnectAttempt} 次）`)
    this.setState('reconnecting')
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null
      this.open()
    }, delay)
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
  }

  private closeSocket(): void {
    const ws = this.ws
    this.ws = null
    if (ws) {
      ws.onclose = null
      ws.onopen = null
      ws.onmessage = null
      ws.onerror = null
      try {
        ws.close()
      } catch {
        /* 已断开 */
      }
    }
  }

  private setState(state: WsConnectionState): void {
    if (this.state === state) return
    this.state = state
    for (const handler of this.stateHandlers) {
      try {
        handler(state)
      } catch (err) {
        console.error('[ws] 连接状态订阅者抛错：', err)
      }
    }
  }
}
