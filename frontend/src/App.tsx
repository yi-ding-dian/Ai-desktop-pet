/**
 * 占位宠物页面：验证透明 / 置顶 / 穿透 / 拖拽四项窗口能力。
 * 本阶段不含 Live2D / WS——接入时替换 .pet-canvas-mount 内的占位内容即可（容器已预留）。
 */
import { useEffect, useRef, useState, type ReactElement } from 'react'
import { getPetBridge } from './shared/pet-bridge'
import type { WindowDebugState } from '../electron/ipc/channels'
import type { Rect } from '../electron/window'

const INITIAL_DEBUG_STATE: WindowDebugState = {
  clickThrough: true,
  alwaysOnTop: true,
  hitboxVisible: false
}

export default function App(): ReactElement {
  const [debug, setDebug] = useState<WindowDebugState>(INITIAL_DEBUG_STATE)
  const hitboxRef = useRef<HTMLDivElement | null>(null)
  const statusBarRef = useRef<HTMLDivElement | null>(null)
  const hoveringRef = useRef(false)
  const draggingRef = useRef(false)

  // ---- 调试状态订阅（快捷键在主进程触发，这里只展示） ----
  useEffect(() => {
    const bridge = getPetBridge()
    void bridge.window.getDebugState().then(setDebug)
    return bridge.window.onDebugStateChanged(setDebug)
  }, [])

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

  // ---- 可交互区域上报（Linux 用作 X11 形状穿透的输入区；含宠物 hitbox 与状态栏） ----
  useEffect(() => {
    const bridge = getPetBridge()
    const report = (): void => {
      const rects: Rect[] = []
      for (const el of [hitboxRef.current, statusBarRef.current]) {
        if (!el) continue
        const r = el.getBoundingClientRect()
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
    report()
    window.addEventListener('resize', report)
    return () => window.removeEventListener('resize', report)
  }, [])

  return (
    <div className="app-root">
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

      <div className="status-bar" ref={statusBarRef}>
        <div>
          穿透：{debug.clickThrough ? '开' : '关'} · 置顶：{debug.alwaysOnTop ? '开' : '关'} · hitbox：
          {debug.hitboxVisible ? '显示' : '隐藏'}
        </div>
        <div className="status-hint">Ctrl+Shift+F9 穿透 · Ctrl+Shift+F10 置顶 · Ctrl+Shift+F11 hitbox</div>
      </div>
    </div>
  )
}
