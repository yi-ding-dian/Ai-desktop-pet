/**
 * 无边框窗口：四边/四角拖动改尺寸（渲染侧手势采集）。
 *
 * 语义与普通窗口一致：只改**被拖的边**，对边固定（主进程按 edges 布尔决定锚点）。
 * 目标尺寸 = pointerdown 时的 innerWidth/innerHeight ± 鼠标位移（绝对目标，不累积误差）；
 * rAF 节流，尺寸未变化不重复上报。主进程负责夹取、请求值记账与业务回调。
 */
import { useCallback, useRef } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { getPetBridge } from '../../pet-bridge'

export type ResizeEdge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'

export interface UseFramelessResizeOptions {
  disabled?: boolean
}

export interface FramelessResizeHandlers {
  onResizeStart: (edge: ResizeEdge, event: ReactPointerEvent<HTMLDivElement>) => void
}

/** 方向 → 拖动的边（true = 该边跟鼠标走） */
function edgesOf(edge: ResizeEdge): {
  left: boolean
  right: boolean
  top: boolean
  bottom: boolean
} {
  return {
    left: edge.includes('w'),
    right: edge.includes('e'),
    top: edge.includes('n'),
    bottom: edge.includes('s')
  }
}

export function useFramelessResize(
  options: UseFramelessResizeOptions = {}
): FramelessResizeHandlers {
  const optionsRef = useRef(options)
  optionsRef.current = options

  const onResizeStart = useCallback(
    (edge: ResizeEdge, event: ReactPointerEvent<HTMLDivElement>) => {
      if (optionsRef.current.disabled || event.button !== 0) return
      event.preventDefault()
      event.stopPropagation()

      let bridge: ReturnType<typeof getPetBridge>['frameless'] | null = null
      try {
        bridge = getPetBridge().frameless
      } catch {
        return
      }
      if (!bridge?.resize) return
      const api = bridge // const 别名：闭包里保持非空收窄

      try {
        event.currentTarget.setPointerCapture(event.pointerId)
      } catch {
        // 指针捕获不可用：窗口内拖动仍可工作
      }

      const edges = edgesOf(edge)
      const startMouseX = event.screenX
      const startMouseY = event.screenY
      const startWidth = window.innerWidth
      const startHeight = window.innerHeight
      let lastWidth = startWidth
      let lastHeight = startHeight
      let rafId = 0
      let pending: { width: number; height: number } | null = null

      const flush = (): void => {
        rafId = 0
        if (!pending) return
        api.resize({ width: pending.width, height: pending.height, ...edges })
        pending = null
      }

      const onMove = (ev: PointerEvent): void => {
        const width = Math.round(
          startWidth +
            (edges.left ? startMouseX - ev.screenX : edges.right ? ev.screenX - startMouseX : 0)
        )
        const height = Math.round(
          startHeight +
            (edges.top ? startMouseY - ev.screenY : edges.bottom ? ev.screenY - startMouseY : 0)
        )
        if (width === lastWidth && height === lastHeight) return
        lastWidth = width
        lastHeight = height
        pending = { width, height }
        if (!rafId) rafId = requestAnimationFrame(flush)
      }

      const onUp = (): void => {
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
        window.removeEventListener('pointercancel', onUp)
        if (rafId) cancelAnimationFrame(rafId)
        rafId = 0
        if (pending) api.resize({ width: pending.width, height: pending.height, ...edges })
        pending = null
      }

      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
      window.addEventListener('pointercancel', onUp)
    },
    []
  )

  return { onResizeStart }
}
