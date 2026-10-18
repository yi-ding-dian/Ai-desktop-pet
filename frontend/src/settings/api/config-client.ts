/**
 * 设置窗后端客户端（settings 域 api 层，设计文档 §7.6.2）。
 *
 * 数据流：设置窗口经 preload `backend.getSnapshot()` 拿 port/token → **自建 WS 连接**
 * （复用 shared/ws-client 与协议类型）→ 收发 `config` / `llm_test_result` / `error`。
 * 不走宠物窗口中转；也不经宠物窗口的 ws-client/bridge.ts（那是宠物窗单例，
 * 本文件是其"独立窗口版"同构接线：快照补连 + ready 重连 + 失败断开）。
 *
 * 容错：window.pet 缺失（浏览器直开页面 / 旧 preload）时不抛错——降级为"离线客户端"，
 * 所有 send 返回 false，页面照常渲染（先例：board 页的 bridge 宽容访问）。
 */
import { getPetBridge } from '../../shared/pet-bridge'
import { WsClient, type WsConnectionState } from '../../shared/ws-client'
import type { ConfigData, ErrorData, LlmTestResultData, TestLlmData } from '../../shared/protocol'
import type { PetBridgeApi } from '../../../electron/ipc/channels'

export interface SettingsBackendClient {
  /** 当前连接状态（同 WsClient 取值） */
  readonly connection: WsConnectionState
  /** 订阅连接状态变化；返回取消订阅函数 */
  onConnectionChange(cb: (state: WsConnectionState) => void): () => void
  /** 订阅配置快照（get_config / set_config 的 `config` 响应）；返回取消订阅函数 */
  onConfig(cb: (config: ConfigData) => void): () => void
  /** 订阅「测试连接」结果（`llm_test_result`）；返回取消订阅函数 */
  onTestResult(cb: (result: LlmTestResultData) => void): () => void
  /** 订阅错误事件（`error`）；返回取消订阅函数 */
  onError(cb: (error: ErrorData) => void): () => void
  /** 发 get_config；连接未就绪返回 false */
  requestConfig(): boolean
  /** 发 set_config{patch}（patch 只含变化字段，key 空=不带）；连接未就绪返回 false */
  saveConfig(patch: Record<string, unknown>): boolean
  /** 发 test_llm；连接未就绪返回 false */
  testLlm(data: TestLlmData): boolean
  /** 断开并释放全部订阅（组件卸载） */
  dispose(): void
}

/** 离线降级实现：无 bridge / bridge 缺失 backend 段时使用（页面可渲染、操作给提示） */
function createOfflineClient(): SettingsBackendClient {
  console.warn('[settings] pet-bridge 不可用，设置页进入离线态（无法读写配置）')
  const noop = (): (() => void) => () => {}
  const fail = (): boolean => false
  return {
    connection: 'idle',
    onConnectionChange: noop,
    onConfig: noop,
    onTestResult: noop,
    onError: noop,
    requestConfig: fail,
    saveConfig: fail,
    testLlm: fail,
    dispose: (): void => {}
  }
}

export function createSettingsBackendClient(): SettingsBackendClient {
  let bridge: PetBridgeApi | null = null
  try {
    bridge = getPetBridge()
  } catch {
    return createOfflineClient()
  }
  if (!bridge?.backend?.getSnapshot) {
    return createOfflineClient()
  }

  // 设置窗角色：后端据此不把行为/提醒主动推送绑到这条连接（2026-10-18）
  const client = new WsClient({ clientRole: 'settings' })

  /**
   * 已释放标志：dispose 后禁止再建连。
   * 踩过坑：getSnapshot() 是异步的（StrictMode 下 effect 快速 double-mount 时，
   * 首个实例的 promise 可能在 dispose 之后才 resolve——若不拦截会"复活"出一个多余连接）。
   */
  let disposed = false

  // 初始快照：覆盖「主进程 ready 早于本窗订阅」的情况（与 ws-client/bridge.ts 同构）
  void bridge.backend
    .getSnapshot()
    .then((snap) => {
      if (disposed) return
      if (snap.state === 'ready' && snap.port && snap.token) {
        client.connect({
          url: `ws://127.0.0.1:${snap.port}/ws`,
          token: snap.token,
          appVersion: snap.appVersion
        })
      }
    })
    .catch((err: unknown) => console.error('[settings] 获取后端快照失败：', err))

  // 后端就绪（含崩溃重启后的新 port + 新 token）→ 重新连接
  const offReady = bridge.backend.onReady?.((ready) => {
    if (disposed) return
    if (import.meta.env.DEV) console.log(`[settings] 后端 ready：port=${ready.port}`)
    client.connect({ url: `ws://127.0.0.1:${ready.port}/ws`, token: ready.token, appVersion: ready.appVersion })
  })

  // 后端停止/失败 → 断开 WS，等待下一次 ready
  const offStatus = bridge.backend.onStatusChanged?.((status) => {
    if (status.state === 'failed' || status.state === 'stopped') {
      client.disconnect()
    }
  })

  return {
    get connection(): WsConnectionState {
      return client.connectionState
    },
    onConnectionChange: (cb) => client.onStateChange(cb),
    onConfig: (cb) => client.on('config', (data) => cb(data)),
    onTestResult: (cb) => client.on('llm_test_result', (data) => cb(data)),
    onError: (cb) => client.on('error', (data) => cb(data)),
    requestConfig: () => client.send('get_config', {}),
    saveConfig: (patch) => client.send('set_config', { patch }),
    testLlm: (data) => client.send('test_llm', data),
    dispose: (): void => {
      disposed = true
      offReady?.()
      offStatus?.()
      client.disconnect()
    }
  }
}
