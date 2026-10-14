/**
 * 根组件：宠物占位 + 顶部状态栏（宠物状态 / 情绪）+ 对话面板 + 底部调试状态栏。
 *
 * P1 打通后：WS 连接与后端状态经 shared/ws-client 与 pet-bridge 接入；
 * Live2D 容器仍为占位（.pet-canvas-mount），后续替换为 Pixi 画布（设计文档 §5.3）。
 */
import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { getPetBridge } from './shared/pet-bridge'
import { setupWsFromBridge } from './shared/ws-client/bridge'
import type { WsClient, WsConnectionState } from './shared/ws-client'
import { emotionEmoji } from './modules/chat/emotions'
import ChatPanel from './modules/chat/ChatPanel'
import type { BackendState, WindowDebugState } from '../electron/ipc/channels'
import type { PetState } from './shared/protocol'
import type { Rect } from '../electron/window'

const INITIAL_DEBUG_STATE: WindowDebugState = {
  clickThrough: true,
  alwaysOnTop: true,
  hitboxVisible: false
}

/** 宠物状态机 → 中文展示（protocol.py StateData 全量取值） */
const STATE_LABEL: Record<PetState, string> = {
  idle: '待机',
  walking: '走动',
  sleeping: '睡觉',
  thinking: '思考中',
  speaking: '说话',
  dragging: '拖拽中'
}

/** WS 连接状态 → 中文展示 */
const WS_LABEL: Record<WsConnectionState, string> = {
  idle: '未连接',
  connecting: '连接中',
  authenticating: '鉴权中',
  connected: '已连接',
  reconnecting: '重连中',
  'auth-failed': '鉴权失败',
  closed: '已断开'
}

/** 后端状态 → 中文展示 */
const BACKEND_LABEL: Record<BackendState | 'unknown', string> = {
  unknown: '未知',
  starting: '启动中',
  ready: '就绪',
  failed: '失败',
  stopped: '已停止'
}

export default function App(): ReactElement {
  const [debug, setDebug] = useState<WindowDebugState>(INITIAL_DEBUG_STATE)
  const [wsState, setWsState] = useState<WsConnectionState>('idle')
  const [petState, setPetState] = useState<PetState>('idle')
  const [emotion, setEmotion] = useState<string>('neutral')
  const [backendState, setBackendState] = useState<BackendState | 'unknown'>('unknown')
  const [lastError, setLastError] = useState<string | null>(null)
  const hitboxRef = useRef<HTMLDivElement | null>(null)
  const statusBarRef = useRef<HTMLDivElement | null>(null)
  const chatPanelRef = useRef<HTMLDivElement | null>(null)
  const hoveringRef = useRef(false)
  const draggingRef = useRef(false)

  // WS 连接（幂等单例；订阅 backend ready 后自动建连）
  const wsClient: WsClient = useMemo(() => setupWsFromBridge(), [])

  // ---- 主进程/后端状态订阅 ----
  useEffect(() => {
    const bridge = getPetBridge()
    void bridge.window.getDebugState().then(setDebug)
    const offDebug = bridge.window.onDebugStateChanged(setDebug)

    void bridge.backend.getSnapshot().then((snap) => setBackendState(snap.state))
    const offBackend = bridge.backend.onStatusChanged((s) => setBackendState(s.state))
    return () => {
      offDebug()
      offBackend()
    }
  }, [])

  // ---- WS 事件订阅：宠物状态 / 情绪 / 错误（顶栏与底栏展示） ----
  useEffect(() => {
    const offs = [
      wsClient.onStateChange(setWsState),
      wsClient.on('state', (d) => setPetState(d.state)),
      wsClient.on('emotion', (d) => setEmotion(d.emotion)),
      wsClient.on('error', (d) => setLastError(`${d.code}: ${d.message}`))
    ]
    return () => offs.forEach((off) => off())
  }, [wsClient])

  // ---- 悬停接管：mousemove 检测光标是否在宠物 hitbox 内 ----
  // 简化：矩形 hitbox；后续接 Live2D 后可升级为像素级 hit-test（画布 alpha 采样）。
  // Linux：物理穿透由窗口形状静态保证，本逻辑负责"形状接管 ↔ 全窗接管"的动态切换；
  // Windows：本逻辑是穿透切换的主力（forward 可转发穿透态下的 mousemove）。
  useEffect(() => {
    const bridge = getPetBridge()

    const handleMove = (e: MouseEvent): void => {
      if (draggingRef.current) return // 拖拽期间穿透由拖拽流程控制，避免跟随抖动误开穿透
      const el = hitboxRef.current
      if (!el) return
      const rect = el.getBoundingClientRect()
      const inside =
        e.clientX >= rect.left && e.clientX < rect.right && e.clientY >= rect.top && e.clientY < rect.bottom
      if (inside === hoveringRef.current) return
      hoveringRef.current = inside
      console.log(`[pet] hitbox ${inside ? 'enter' : 'leave'}`)
      bridge.window.setClickThrough(!inside)
    }

    window.addEventListener('mousemove', handleMove)
    return () => window.removeEventListener('mousemove', handleMove)
  }, [])

  // ---- 拖拽（自绘：pointerdown 起点 + pointermove 坐标流 → 主进程 setBounds 跟随；禁用 -webkit-app-region） ----
  // 不用主进程轮询 screen.getCursorScreenPoint()：该 API 在 X11 上为事件驱动缓存（实测光标出窗即冻结），
  // 渲染侧 pointer capture 能保证光标滑出窗口后事件仍连续送达（X11 指针 grab），坐标更可靠。
  useEffect(() => {
    const el = hitboxRef.current
    if (!el) return
    const bridge = getPetBridge()
    let rafId = 0
    let pending: { x: number; y: number } | null = null

    const flush = (): void => {
      rafId = 0
      if (pending) {
        bridge.window.dragMove(pending)
        pending = null
      }
    }

    const handlePointerDown = (e: PointerEvent): void => {
      if (e.button !== 0 || draggingRef.current) return
      draggingRef.current = true
      el.setPointerCapture(e.pointerId)
      console.log('[pet] drag start')
      bridge.window.startDrag({ x: e.screenX, y: e.screenY })
      e.preventDefault()
    }

    const handlePointerMove = (e: PointerEvent): void => {
      if (!draggingRef.current) return
      // rAF 节流：pointermove 频率可能远高于帧率，每帧最多发一次坐标
      pending = { x: e.screenX, y: e.screenY }
      if (!rafId) rafId = requestAnimationFrame(flush)
    }

    const handlePointerUp = (e: PointerEvent): void => {
      if (!draggingRef.current) return
      draggingRef.current = false
      // 最后对齐到抬起位置，再结束拖拽
      bridge.window.dragMove({ x: e.screenX, y: e.screenY })
      if (rafId) cancelAnimationFrame(rafId)
      rafId = 0
      pending = null
      if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId)
      console.log('[pet] drag end')
      bridge.window.endDrag()
      // 拖拽结束时不改穿透：光标仍在宠物上 → 保持接管；移出时 mousemove 逻辑会恢复
    }

    el.addEventListener('pointerdown', handlePointerDown)
    el.addEventListener('pointermove', handlePointerMove)
    el.addEventListener('pointerup', handlePointerUp)
    el.addEventListener('pointercancel', handlePointerUp)
    return () => {
      el.removeEventListener('pointerdown', handlePointerDown)
      el.removeEventListener('pointermove', handlePointerMove)
      el.removeEventListener('pointerup', handlePointerUp)
      el.removeEventListener('pointercancel', handlePointerUp)
      if (rafId) cancelAnimationFrame(rafId)
    }
  }, [])

  // ---- 可交互区域上报（Linux 用作 X11 形状穿透的输入区；含宠物 hitbox、聊天面板、状态栏） ----
  // 聊天面板尺寸会随消息变化，用 ResizeObserver 跟随，rAF 合并上报频次。
  useEffect(() => {
    const bridge = getPetBridge()
    let rafId = 0

    const doReport = (): void => {
      const rects: Rect[] = []
      for (const el of [hitboxRef.current, chatPanelRef.current, statusBarRef.current]) {
        if (!el) continue
        const r = el.getBoundingClientRect()
        if (r.width === 0 || r.height === 0) continue
        rects.push({
          x: Math.round(r.left),
          y: Math.round(r.top),
          width: Math.round(r.width),
          height: Math.round(r.height)
        })
      }
      if (rects.length === 0) return
      bridge.window.reportInteractiveRects(rects)
      console.log(`[pet] interactive rects = ${JSON.stringify(rects)}`)
    }

    const report = (): void => {
      if (rafId) return
      rafId = requestAnimationFrame(() => {
        rafId = 0
        doReport()
      })
    }

    report()
    const observers: ResizeObserver[] = []
    for (const el of [hitboxRef.current, chatPanelRef.current, statusBarRef.current]) {
      if (!el) continue
      const ro = new ResizeObserver(report)
      ro.observe(el)
      observers.push(ro)
    }
    window.addEventListener('resize', report)
    return () => {
      if (rafId) cancelAnimationFrame(rafId)
      observers.forEach((ro) => ro.disconnect())
      window.removeEventListener('resize', report)
    }
  }, [])

  return (
    <div className="app-root">
      {/* 顶部状态栏：宠物状态 + 当前情绪（emotion 事件的占位表现） */}
      <div className="pet-status-bar" data-testid="pet-status-bar">
        <span className="pet-state" data-testid="pet-state">
          {STATE_LABEL[petState]}
        </span>
        <span className="pet-emotion" data-testid="pet-emotion">
          {emotionEmoji(emotion)} {emotion}
        </span>
      </div>

      {/* Live2D 容器占位：P1 后续在此挂载 Pixi 画布，本阶段放占位物 */}
      <div
        ref={hitboxRef}
        className={`pet-canvas-mount${debug.hitboxVisible ? ' debug' : ''}`}
        data-testid="pet-hitbox"
      >
        <span className="pet-placeholder" role="img" aria-label="宠物占位">
          🐧
        </span>
      </div>

      {/* 对话域：输入框 + 气泡列表（订阅 WS token/emotion/reply_*） */}
      <ChatPanel client={wsClient} containerRef={chatPanelRef} />

      <div className="status-bar" ref={statusBarRef}>
        <div>
          后端：{BACKEND_LABEL[backendState]} · WS：{WS_LABEL[wsState]}
          {lastError ? <span className="status-error"> · ⚠ {lastError}</span> : null}
        </div>
        <div>
          穿透 {debug.clickThrough ? '开' : '关'} · 置顶 {debug.alwaysOnTop ? '开' : '关'} · hitbox{' '}
          {debug.hitboxVisible ? '显示' : '隐藏'} · F9/F10/F11
        </div>
      </div>
    </div>
  )
}
