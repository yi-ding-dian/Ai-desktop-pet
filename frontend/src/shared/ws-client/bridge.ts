/**
 * pet-bridge ↔ WsClient 接线：主进程下发后端 ready（port + token）后开始 WS 连接。
 *
 * 时序（设计文档 §3.4）：窗口渲染 → 订阅 backend 状态 → 收到 ready → connect →
 * hello 鉴权 → hello_ack ok → connected。
 * 若 subscribe 晚于 ready（HMR reload 等），用 getSnapshot() 补一次连接信息。
 */
import { getPetBridge } from '../pet-bridge'
import { WsClient } from './index'

let client: WsClient | null = null

/** 建立（幂等的）全局 WS 连接；返回客户端单例供各业务域订阅/发送 */
export function setupWsFromBridge(): WsClient {
  if (client) return client
  // 宠物窗角色：行为/提醒主动推送只绑 pet（设置窗自建连接用 settings，不抢通道）
  const wsClient = new WsClient({ clientRole: 'pet' })
  client = wsClient

  const bridge = getPetBridge()
  const connectTo = (info: { port: number; token: string; appVersion: string }): void => {
    // 后端 FastAPI 的 WS 端点在 /ws（backend/interfaces/ws/server.py）
    wsClient.connect({
      url: `ws://127.0.0.1:${info.port}/ws`,
      token: info.token,
      appVersion: info.appVersion
    })
  }

  // 初始快照：覆盖「主进程 ready 早于渲染进程订阅」的情况
  void bridge.backend
    .getSnapshot()
    .then((snap) => {
      console.log(`[ws-bridge] 初始快照：state=${snap.state}${snap.port ? ` port=${snap.port}` : ''}`)
      if (snap.state === 'ready' && snap.port && snap.token) {
        connectTo({ port: snap.port, token: snap.token, appVersion: snap.appVersion })
      }
    })
    .catch((err: unknown) => console.error('[ws-bridge] 获取后端快照失败：', err))

  // 后端就绪（含崩溃重启后的新端口 + 新 token）→ 重新连接 + 重新 hello
  bridge.backend.onReady((ready) => {
    console.log(`[ws-bridge] 后端 ready：port=${ready.port} pid=${ready.pid}`)
    connectTo(ready)
  })

  // 后端停止/失败 → 断开 WS，等待下一次 ready
  bridge.backend.onStatusChanged((status) => {
    console.log(`[ws-bridge] 后端状态：${status.state}${status.message ? `（${status.message}）` : ''}`)
    if (status.state === 'failed' || status.state === 'stopped') {
      wsClient.disconnect()
    }
  })

  return wsClient
}
