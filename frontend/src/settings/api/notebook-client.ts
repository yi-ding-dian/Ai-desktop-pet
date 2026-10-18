/**
 * 设置窗「记忆本」后端客户端（settings 域 api 层，2026-10-18）。
 *
 * 与 config-client 同构：设置窗经 preload `backend.getSnapshot()` 拿 port/token，
 * 自建一条 role='settings' 的 WS 连接（设置页的配置连接与记忆本连接互不影响；
 * 后端支持多连接）。收发 `notebook_items` / `notebook_result` / `error`。
 *
 * 容错：window.pet 缺失（浏览器直开页面 / 旧 preload）时降级为离线客户端，
 * 所有 send 返回 false，页面照常渲染。
 */
import { getPetBridge } from '../../shared/pet-bridge'
import { WsClient, type WsConnectionState } from '../../shared/ws-client'
import type {
  ErrorData,
  NotebookItemInput,
  NotebookItemsData,
  NotebookKind,
  NotebookResultData
} from '../../shared/protocol'
import type { PetBridgeApi } from '../../../electron/ipc/channels'

export interface NotebookBackendClient {
  readonly connection: WsConnectionState
  onConnectionChange(cb: (state: WsConnectionState) => void): () => void
  onItems(cb: (data: NotebookItemsData) => void): () => void
  onResult(cb: (data: NotebookResultData) => void): () => void
  onError(cb: (data: ErrorData) => void): () => void
  requestList(kind?: NotebookKind | null): boolean
  save(items: NotebookItemInput[]): boolean
  rename(oldName: string, newName: string): boolean
  delete(names: string[]): boolean
  dispose(): void
}

function createOfflineClient(): NotebookBackendClient {
  console.warn('[notebook] pet-bridge 不可用，记忆本面板进入离线态')
  const noop = (): (() => void) => () => {}
  const fail = (): boolean => false
  return {
    connection: 'idle',
    onConnectionChange: noop,
    onItems: noop,
    onResult: noop,
    onError: noop,
    requestList: fail,
    save: fail,
    rename: fail,
    delete: fail,
    dispose: (): void => {}
  }
}

export function createNotebookBackendClient(): NotebookBackendClient {
  let bridge: PetBridgeApi | null = null
  try {
    bridge = getPetBridge()
  } catch {
    return createOfflineClient()
  }
  if (!bridge?.backend?.getSnapshot) {
    return createOfflineClient()
  }

  // 设置窗角色：后端不把行为/提醒主动推送绑到这条连接
  const client = new WsClient({ clientRole: 'settings' })
  let disposed = false

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
    .catch((err: unknown) => console.error('[notebook] 获取后端快照失败：', err))

  const offReady = bridge.backend.onReady?.((ready) => {
    if (disposed) return
    client.connect({
      url: `ws://127.0.0.1:${ready.port}/ws`,
      token: ready.token,
      appVersion: ready.appVersion
    })
  })

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
    onItems: (cb) => client.on('notebook_items', (data) => cb(data)),
    onResult: (cb) => client.on('notebook_result', (data) => cb(data)),
    onError: (cb) => client.on('error', (data) => cb(data)),
    requestList: (kind) => client.send('notebook_list', { kind: kind ?? null }),
    save: (items) => client.send('notebook_save', { items }),
    rename: (oldName, newName) =>
      client.send('notebook_rename', { old_name: oldName, new_name: newName }),
    delete: (names) => client.send('notebook_delete', { names }),
    dispose: (): void => {
      disposed = true
      offReady?.()
      offStatus?.()
      client.disconnect()
    }
  }
}
