/**
 * 气泡窗应用（bubble.html 的唯一组件）：订阅主进程内容 → 渲染 PetBubble → 回报尺寸/动作/退场。
 *
 * 职责（单一）：本窗是"哑渲染面"——不认识业务（菜单项含义/确认动作都在主进程解释），
 * 只做四件事：① onOpen 收内容（按 session 去重，补发幂等）；② 尺寸经 PetBubble 的 onSize
 * 上报（主进程动态调窗）；③ 用户动作经 bubble.action 回传；④ 退场动画播毕 notifyClosed
 * （主进程 hide；超时兜底在主进程）。
 *
 * 兼容与容错：bridge 缺失（浏览器直开调试）时订阅静默跳过、渲染空 stage；
 * 模块级缓存 lastPayload/lastSession 兜底"did-finish-load 早于 React 订阅建立"的首帧丢失
 * （主进程 show 后还会延迟补发一次——双保险）。
 */
import { useCallback, useEffect, useState, type ReactElement } from 'react'
import { getPetBridge } from '../shared/pet-bridge'
import type { BubbleOpenPayload, BubbleTail, PetBridgeApi } from '../../electron/ipc/channels'
import PetBubble from './PetBubble'
import './bubble.css'

/** 模块级内容缓存（React 订阅建立前到达的载荷不丢；StrictMode 双挂载也不丢） */
let lastPayload: BubbleOpenPayload | null = null
/** 已消费的会话序号（同 session 补发幂等：只认不重播动画） */
let lastSession = -1

/** dev 态日志（转发到主进程日志，便于无 devtools 验证）；生产构建自动剔除 */
const devLog = (msg: string): void => {
  if (import.meta.env.DEV) console.log(`[bubble] ${msg}`)
}

/** 宽容取 bubble 段：bridge 缺失（浏览器直开调试）或旧 preload 无本段时返回 undefined（静默降级） */
function bubbleBridge(): PetBridgeApi['bubble'] | undefined {
  try {
    return getPetBridge().bubble
  } catch {
    return undefined
  }
}

export default function BubbleApp(): ReactElement {
  const [payload, setPayload] = useState<BubbleOpenPayload | null>(lastPayload)
  const [tail, setTail] = useState<BubbleTail>(lastPayload?.tail ?? 'down')
  const [closing, setClosing] = useState(false)

  useEffect(() => {
    const bridge = bubbleBridge()
    if (!bridge) {
      devLog('bridge 不可用（浏览器直开调试？）——静态渲染，交互静默')
      return
    }
    const offOpen = bridge.onOpen((p) => {
      if (!p || typeof p.session !== 'number') return
      if (p.session === lastSession) return // 补发幂等：同 session 不重播动画
      lastSession = p.session
      lastPayload = p
      setPayload(p)
      setTail(p.tail)
      setClosing(false)
      devLog(`open session=${p.session} variant=${p.variant} tail=${p.tail}`)
    })
    const offClose = bridge.onRequestClose(() => {
      devLog('收到收起请求（播退场动画）')
      setClosing(true)
    })
    const offTail = bridge.onSetTail((t) => {
      if (t === 'down' || t === 'up') setTail(t)
    })
    // 就绪回报（主进程 waitBubbleReady 唤醒 + 补发内容）
    bridge.ready()
    return () => {
      offOpen()
      offClose()
      offTail()
    }
  }, [])

  /** 用户动作（项 id / confirm / cancel）→ 主进程分发执行 */
  const handleAction = useCallback((id: string) => {
    devLog(`action → ${id}`)
    bubbleBridge()?.action(id)
  }, [])

  /** 内容尺寸上报（主进程 setBounds 动态调窗 + 防出屏重定位） */
  const handleSize = useCallback((size: { width: number; height: number }) => {
    bubbleBridge()?.reportSize(size)
  }, [])

  /** 退场动画播毕 → 主进程隐藏窗口 */
  const handleExited = useCallback(() => {
    devLog('退场动画播毕 → 回报主进程')
    bubbleBridge()?.notifyClosed()
  }, [])

  if (!payload) return <div className="bubble-stage" />

  return (
    <PetBubble
      key={payload.session}
      variant={payload.variant}
      items={payload.variant === 'menu' ? payload.items : undefined}
      message={payload.variant !== 'menu' ? payload.message : undefined}
      confirmLabel={payload.variant === 'confirm' ? payload.confirmLabel : undefined}
      cancelLabel={payload.variant === 'confirm' ? payload.cancelLabel : undefined}
      tail={tail}
      motion={payload.motion}
      closing={closing}
      onAction={handleAction}
      onSize={handleSize}
      onExited={handleExited}
    />
  )
}
