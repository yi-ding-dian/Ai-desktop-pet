/**
 * 设置页「记忆本」数据流（settings 域 hook，2026-10-18）。
 *
 * 职责：自建一条 role='settings' 的 WS 连接 → 拉列表 / 保存 / 改名 / 删记录；
 * 打开与外链/本机路径走 pet-bridge；真实文件删除走主进程原生确认框
 * （``settings.deletePath``），确认并成功后让后端移除对应记录。
 *
 * 所有写操作都由后端回 ``memory_book_result`` + 最新 ``memory_book_items``；
 * 前端不做乐观更新——列表以服务端快照为准，避免多端（宠物/设置页）不一致。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { getPetBridge } from '../../shared/pet-bridge'
import type {
  MemoryBookItemData,
  MemoryBookItemInput,
  MemoryBookKind
} from '../../shared/protocol'
import type { WsConnectionState } from '../../shared/ws-client'
import {
  createMemoryBookBackendClient,
  type MemoryBookBackendClient
} from './memory-book-client'

export type MemoryBookFilter = 'all' | MemoryBookKind

export interface MemoryBookNotice {
  kind: 'info' | 'success' | 'error'
  text: string
}

export interface MemoryBookController {
  connection: WsConnectionState
  items: MemoryBookItemData[]
  count: number
  loading: boolean
  notice: MemoryBookNotice | null
  filter: MemoryBookFilter
  setFilter: (filter: MemoryBookFilter) => void
  refresh: () => void
  saveItem: (input: MemoryBookItemInput) => void
  renameItem: (oldName: string, newName: string) => void
  deleteRecord: (names: string[]) => void
  deleteFile: (item: MemoryBookItemData) => void
  openItem: (item: MemoryBookItemData) => void
  /** program 条目：直接启动（用户亲手登记，免确认；2026-10-19） */
  runItem: (item: MemoryBookItemData) => void
  dismissNotice: () => void
}

export function useMemoryBookController(): MemoryBookController {
  const clientRef = useRef<MemoryBookBackendClient | null>(null)
  const [connection, setConnection] = useState<WsConnectionState>('idle')
  const [items, setItems] = useState<MemoryBookItemData[]>([])
  const [count, setCount] = useState(0)
  const [loading, setLoading] = useState(false)
  const [notice, setNotice] = useState<MemoryBookNotice | null>(null)
  const [filter, setFilter] = useState<MemoryBookFilter>('all')

  useEffect(() => {
    const client = createMemoryBookBackendClient()
    clientRef.current = client

    const offConn = client.onConnectionChange((state) => {
      setConnection(state)
      if (state === 'connected') {
        setLoading(true)
        client.requestList()
      } else {
        // 断线/重连中：别让“正在读取…”无限转；连接恢复后会再拉一次
        setLoading(false)
      }
    })
    const offItems = client.onItems((data) => {
      setItems(data.items)
      setCount(data.count)
      setLoading(false)
    })
    const offResult = client.onResult((data) => {
      if (data.message) {
        setNotice({ kind: data.ok ? 'success' : 'error', text: data.message })
      } else if (!data.ok) {
        setNotice({ kind: 'error', text: '操作没有成功，再试一次好吗？' })
      }
      if (!data.ok) setLoading(false)
      // 成功时服务端随后推 memory_book_items，loading 在那里结束
    })
    const offError = client.onError((data) => {
      setNotice({ kind: 'error', text: data.message || '后端出错了' })
      setLoading(false)
    })

    // 连接状态变为 connected 时拉取；客户端刚创建时尚未建连，不在这里空发
    return () => {
      offConn()
      offItems()
      offResult()
      offError()
      client.dispose()
      clientRef.current = null
    }
  }, [])

  // 设置窗重新获得焦点时刷新一次：宠物对话里保存/删除的条目能及时同步过来
  //（设置页与宠物窗各自持有一条 WS 连接，后端不跨连接广播列表）
  useEffect(() => {
    const onFocus = (): void => {
      const client = clientRef.current
      if (client && client.connection === 'connected') client.requestList()
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [])

  const sendOrWarn = useCallback((sent: boolean, action: string): boolean => {
    if (!sent) {
      setNotice({ kind: 'error', text: `还没连上后端，${action}没发出去。` })
      setLoading(false)
      return false
    }
    return true
  }, [])

  const refresh = useCallback(() => {
    const client = clientRef.current
    if (!client) return
    setLoading(true)
    if (!client.requestList()) sendOrWarn(false, '刷新')
  }, [sendOrWarn])

  const saveItem = useCallback(
    (input: MemoryBookItemInput) => {
      const client = clientRef.current
      if (!client) return
      if (!input.value.trim()) {
        setNotice({ kind: 'error', text: '内容不能为空。' })
        return
      }
      setLoading(true)
      if (!client.save([input])) sendOrWarn(false, '保存')
    },
    [sendOrWarn]
  )

  const renameItem = useCallback(
    (oldName: string, newName: string) => {
      const client = clientRef.current
      if (!client) return
      if (!newName.trim()) {
        setNotice({ kind: 'error', text: '新名字不能为空。' })
        return
      }
      setLoading(true)
      if (!client.rename(oldName, newName)) sendOrWarn(false, '改名')
    },
    [sendOrWarn]
  )

  const deleteRecord = useCallback(
    (names: string[]) => {
      const client = clientRef.current
      if (!client || names.length === 0) return
      setLoading(true)
      if (!client.delete(names)) sendOrWarn(false, '删除记录')
    },
    [sendOrWarn]
  )

  const openItem = useCallback((item: MemoryBookItemData) => {
    if (item.kind === 'text') {
      setNotice({ kind: 'info', text: '这是一段文字，不是链接或文件。' })
      return
    }
    if (item.kind === 'program') {
      setNotice({ kind: 'info', text: '这是程序条目，请点「运行」。' })
      return
    }
    if (item.kind === 'path' && !item.path_exists) {
      setNotice({ kind: 'error', text: `路径不存在：${item.value}` })
      return
    }
    const system = getPetBridge().system
    if (!system) {
      setNotice({ kind: 'error', text: '这个版本还不支持打开链接或文件。' })
      return
    }
    const task =
      item.kind === 'path' ? system.openPath(item.value) : system.openExternal(item.value)
    void task
      .then((result) => {
        if (!result.ok) {
          setNotice({ kind: 'error', text: result.message || '打不开这个链接或文件。' })
        }
      })
      .catch((err: unknown) => {
        setNotice({ kind: 'error', text: `打不开：${String(err)}` })
      })
  }, [])

  const runItem = useCallback((item: MemoryBookItemData) => {
    if (item.kind !== 'program') return
    if (!item.path_exists) {
      setNotice({ kind: 'error', text: `程序不存在或不可执行：${item.value}` })
      return
    }
    const launcher = getPetBridge().launcher
    if (!launcher?.runProgram) {
      setNotice({ kind: 'error', text: '这个版本还不支持启动程序。' })
      return
    }
    void launcher
      .runProgram({
        mode: 'path',
        path: item.value,
        name: item.name,
        // 用户亲手登记在记忆本里的程序：设置页点「运行」即明确操作，免确认
        trusted: true
      })
      .then((result) => {
        if (!result.ok) {
          setNotice({ kind: 'error', text: result.message || '没能启动这个程序。' })
          return
        }
        setNotice({
          kind: 'success',
          text: `已经启动『${result.appName || item.name}』。`
        })
      })
      .catch((err: unknown) => {
        setNotice({ kind: 'error', text: `启动失败：${String(err)}` })
      })
  }, [])

  const deleteFile = useCallback(
    (item: MemoryBookItemData) => {
      const settings = getPetBridge().settings
      if (!settings?.deletePath) {
        setNotice({ kind: 'error', text: '这个版本还不支持删除文件。' })
        return
      }
      setLoading(true)
      void settings
        .deletePath(item.value)
        .then((result) => {
          if (!result.confirmed) {
            setNotice({ kind: 'info', text: '已取消，什么都没删。' })
            setLoading(false)
            return
          }
          if (!result.ok) {
            setNotice({ kind: 'error', text: result.message || '删除失败。' })
            setLoading(false)
            return
          }
          setNotice({ kind: 'success', text: `已把『${item.name}』放进回收站。` })
          // 文件已删：让后端移除记录并清理长期记忆；服务端随后推最新列表
          const sent = clientRef.current?.delete([item.name]) ?? false
          if (!sent) {
            setNotice({
              kind: 'error',
              text: '文件已删除，但还没连上后端，记忆本记录暂时没移除。'
            })
            setLoading(false)
          }
        })
        .catch((err: unknown) => {
          setNotice({ kind: 'error', text: `删除失败：${String(err)}` })
          setLoading(false)
        })
    },
    []
  )

  const dismissNotice = useCallback(() => setNotice(null), [])

  return {
    connection,
    items,
    count,
    loading,
    notice,
    filter,
    setFilter,
    refresh,
    saveItem,
    renameItem,
    deleteRecord,
    deleteFile,
    openItem,
    runItem,
    dismissNotice
  }
}
