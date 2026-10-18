/**
 * 气泡窗应用（bubble.html 的唯一组件）：订阅主进程内容 → 渲染 PetBubble → 回报尺寸/动作/退场。
 *
 * 职责（单一）：本窗是"哑渲染面"——不认识业务（菜单项含义/确认动作都在主进程解释），
 * 只做四件事：① onOpen 收内容（按 session 去重，补发幂等）；② 尺寸经 PetBubble 的 onSize
 * 上报（主进程动态调窗）；③ 用户动作经 bubble.action 回传；④ 退场动画播毕 notifyClosed
 * （主进程 hide；超时兜底在主进程）。说话气泡（text）另有 onUpdate：同 session 内容更新
 * （只换文字不重播入场——流式刷新走它）。
 *
 * 兼容与容错：bridge 缺失（浏览器直开调试）时订阅静默跳过、渲染空 stage；
 * 模块级缓存 lastPayload/lastSession 兜底"did-finish-load 早于 React 订阅建立"的首帧丢失
 * （主进程 show 后还会延迟补发一次——双保险）。
 */
import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import { getPetBridge } from '../shared/pet-bridge'
import type {
  BubbleOpenPayload,
  BubbleTail,
  BubbleUpdatePayload,
  PetBridgeApi
} from '../../electron/ipc/channels'
import type { Rect } from '../../electron/window'
import PetBubble from './PetBubble'
import './bubble.css'

/** 模块级内容缓存（React 订阅建立前到达的载荷不丢；StrictMode 双挂载也不丢） */
let lastPayload: BubbleOpenPayload | null = null
/** 已消费的会话序号（同 session 补发幂等：只认不重播动画） */
let lastSession = -1

/**
 * "尺寸稳定"判定窗口（ms）：最后一次内容尺寸上报后等这么久再触发**强制重绘重挂载**
 * （此时主进程已完成 setBounds、窗口尺寸不再变化）。详见 handleSize 内注释。
 */
const REFLOW_SETTLE_MS = 320

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
  /** 强制重绘代数（>0 时以 motion='instant' 重挂载 PetBubble——真机渲染 bug 修复，见 handleSize） */
  const [reflowGen, setReflowGen] = useState(0)
  /** 本次弹出是否已做过重挂载（防"重挂载→尺寸上报→再重挂载"循环） */
  const reflowDoneRef = useRef(false)
  /** 尺寸稳定判定定时器（onOpen 重置 / onRequestClose 取消） */
  const reflowTimerRef = useRef(0)
  /** 当前窗口是否为复用窗口（Windows）：复用窗口跳过"尺寸稳定重挂载"补偿，避免入场动画中途再渲染一次 */
  const stableWindowRef = useRef(lastPayload?.stableWindow === true)

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
      stableWindowRef.current = p.stableWindow === true
      setPayload(p)
      setTail(p.tail)
      setClosing(false)
      // 新 session：重置强制重绘状态（本次弹出尚未重挂载）
      reflowDoneRef.current = false
      window.clearTimeout(reflowTimerRef.current)
      setReflowGen(0)
      devLog(`open session=${p.session} variant=${p.variant} tail=${p.tail}`)
    })
    // 说话气泡流式刷新：同 session 只换文字（不重挂、不重播入场动画）；
    // 异 session（旧内容迟到，如已切菜单）忽略。兼容旧 preload（无 onUpdate——重启前过渡态）静默跳过
    const offUpdate: () => void =
      typeof bridge.onUpdate === 'function'
        ? bridge.onUpdate((p: BubbleUpdatePayload) => {
            if (!p || p.session !== lastSession) return
            setPayload((prev) =>
              prev && prev.variant === 'text'
                ? { ...prev, message: p.message, meta: p.meta ?? prev.meta }
                : prev
            )
          })
        : () => {}
    const offClose = bridge.onRequestClose(() => {
      devLog('收到收起请求（播退场动画）')
      // 退场开始：取消未触发的强制重绘重挂载（避免打断退场动画）
      window.clearTimeout(reflowTimerRef.current)
      setClosing(true)
    })
    const offTail = bridge.onSetTail((t) => {
      if (t === 'down' || t === 'up') setTail(t)
    })
    // 就绪回报（主进程 waitBubbleReady 唤醒 + 补发内容）
    bridge.ready()
    return () => {
      offOpen()
      offUpdate()
      offClose()
      offTail()
    }
  }, [])

  /** 用户动作（项 id / confirm / cancel）→ 主进程分发执行 */
  const handleAction = useCallback((id: string) => {
    devLog(`action → ${id}`)
    bubbleBridge()?.action(id)
  }, [])

  /**
   * 内容尺寸上报（主进程 setBounds 动态调窗 + 防出屏重定位）。
   *
   * 尺寸稳定后触发一次**强制重绘重挂载**（2026-10-16 真机渲染 bug 的最终修复）：KWin/Chromium
   * 真机上，气泡窗"窗口尺寸稳定后若不再有任何内容变化"，画面会停在残缺状态——窗口/布局/上报
   * 全部正确，但"画"缺块（部分区域从未被光栅化）。实证：说话气泡流式生长必正常（持续内容变化
   * 触发绘制）；右键菜单、让位后恢复的说话气泡等**一次性内容必残**。排查排除：invalidate 强制
   * 重绘 ✗、外部真实 resize ✗、绘制属性抖动（visibility / 背景色差 / 提层 will-change）✗、
   * hover 变色仅局部 ✓——**只有 DOM 级重建（重挂载）能全局强制重绘**（HMR 重挂载实测修复）。
   * 故：最后一次上报后 REFLOW_SETTLE_MS 换 key 重挂载一次；重挂载以 motion='instant'
   * （noop 关键帧，见 bubble.css）零观感完成、且只做一次（reflowDoneRef 防循环——
   * 重挂载会再次上报尺寸）。退场开始（onRequestClose）时取消。
   */
  const handleSize = useCallback((size: { width: number; height: number }) => {
    bubbleBridge()?.reportSize(size)
    window.clearTimeout(reflowTimerRef.current)
    // 复用窗口（Windows）跳过"尺寸稳定 → 强制重绘重挂载"：该补偿只对 Linux/KWin 残屏必要；
    // 在复用窗口上它会在入场动画进行到约 320ms 时再整树重渲染一次，观感就是"分了两段弹出"
    if (stableWindowRef.current) return
    reflowTimerRef.current = window.setTimeout(() => {
      if (reflowDoneRef.current) return
      reflowDoneRef.current = true
      devLog('尺寸稳定 → 强制重绘重挂载')
      setReflowGen((g) => g + 1)
    }, REFLOW_SETTLE_MS)
  }, [])

  /** 交互形状上报（说话气泡悬浮交互；Linux 主进程据此 setShape 裁输入区，其余透明区完全穿透）。
   *  可选链容错——旧 preload 无 reportShape 时静默跳过（整窗可交互，功能仍通） */
  const handleShape = useCallback((rects: Rect[]) => {
    bubbleBridge()?.reportShape?.(rects)
  }, [])

  /** 退场动画播毕 → 主进程隐藏窗口；复用窗口同时清空内容，避免下次 show 先闪一帧旧菜单 */
  const handleExited = useCallback(() => {
    devLog('退场动画播毕 → 回报主进程')
    bubbleBridge()?.notifyClosed()
    lastPayload = null
    setPayload(null)
  }, [])

  if (!payload) return <div className="bubble-stage" />

  return (
    <PetBubble
      // key 含重挂载代数（reflowGen>0 = 尺寸稳定后的强制重绘重挂载——真正生效的 key 是
      // session+代数组合；重挂载时以 instant 运动预设零观感，见 handleSize 注释）
      key={`${payload.session}-${reflowGen}`}
      variant={payload.variant}
      items={payload.variant === 'menu' ? payload.items : undefined}
      message={payload.variant !== 'menu' ? payload.message : undefined}
      meta={payload.variant === 'text' ? payload.meta : undefined}
      confirmLabel={payload.variant === 'confirm' ? payload.confirmLabel : undefined}
      cancelLabel={payload.variant === 'confirm' ? payload.cancelLabel : undefined}
      tail={tail}
      motion={reflowGen > 0 ? { enter: 'instant', exit: payload.motion.exit } : payload.motion}
      closing={closing}
      onAction={handleAction}
      onSize={handleSize}
      onShape={handleShape}
      onExited={handleExited}
    />
  )
}
