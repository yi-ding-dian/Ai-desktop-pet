/**
 * 无边框窗口：标题栏拖动（渲染侧手势采集）。
 *
 * 只负责把指针手势翻译成 bridge.frameless.move 的 start/move/end：
 *  - 位移是**相对手势起点**的累计值（每帧绝对值，不累积误差）；
 *  - rAF 节流，抬指针前补发最后一帧；
 *  - 默认忽略按钮/输入框/链接等交互元素（右上角 × 不参与拖动）。
 * 主进程负责工作区夹取、请求值记账与业务回调（electron/window/frameless.ts）。
 */
import { useCallback, useRef } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { getPetBridge } from '../../pet-bridge'

export interface UseFramelessMoveOptions {
  disabled?: boolean
  /** 不参与拖动的元素选择器（默认按钮/输入/链接/带 data-no-drag 的元素） */
  ignoreSelector?: string
}

export interface FramelessMoveHandlers {
  onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void
}

const DEFAULT_IGNORE = 'button, input, textarea, select, a, [data-no-drag]'

export function useFramelessMove(options: UseFramelessMoveOptions = {}): FramelessMoveHandlers {
  // 用 ref 保存最新选项：handler 保持稳定，避免每次渲染重建监听
  const optionsRef = useRef(options)
  optionsRef.current = options

  const onPointerDown = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    const opts = optionsRef.current
    if (opts.disabled || event.button !== 0) return
    const target = event.target as HTMLElement | null
    if (target?.closest(opts.ignoreSelector ?? DEFAULT_IGNORE)) return

    // 浏览器直开调试 / 旧 preload：没有 bridge 时静默降级（不拖动）
    let bridge: ReturnType<typeof getPetBridge>['frameless'] | null = null
    try {
      bridge = getPetBridge().frameless
    } catch {
      return
    }
    if (!bridge?.move) return
    const api = bridge // const 别名：闭包里保持非空收窄

    event.preventDefault()
    try {
      event.currentTarget.setPointerCapture(event.pointerId)
    } catch {
      // 指针捕获不可用（旧环境）：窗口内拖动仍可工作，只是快速甩出窗口时可能丢帧
    }

    const startX = event.screenX
    const startY = event.screenY
    let rafId = 0
    let pending: { dx: number; dy: number } | null = null

    const flush = (): void => {
      rafId = 0
      if (!pending) return
      api.move({ phase: 'move', dx: pending.dx, dy: pending.dy })
      pending = null
    }

    const onMove = (ev: PointerEvent): void => {
      pending = { dx: ev.screenX - startX, dy: ev.screenY - startY }
      if (!rafId) rafId = requestAnimationFrame(flush)
    }

    const onUp = (ev: PointerEvent): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
      if (rafId) cancelAnimationFrame(rafId)
      rafId = 0
      if (pending) api.move({ phase: 'move', dx: pending.dx, dy: pending.dy })
      pending = null
      api.move({ phase: 'end', dx: ev.screenX - startX, dy: ev.screenY - startY })
    }

    api.move({ phase: 'start', dx: 0, dy: 0 })
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
  }, [])

  return { onPointerDown }
}
