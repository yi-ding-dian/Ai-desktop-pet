/**
 * 弹窗（应用内面板）八向改尺寸：与窗口缩放同一套语义（只动被拖的边、对边固定），
 * 但操作的是 CSS 尺寸/位置，不经过主进程窗口 IPC。
 * 首次拖动后改为 fixed 定位并保持左上角，避免 flex 居中让位置随尺寸跳动。
 */
import { useCallback, useRef, useState } from 'react'
import type { CSSProperties, PointerEvent as ReactPointerEvent, RefObject } from 'react'
import type { ResizeEdge } from './useFramelessResize'

export interface ResizablePanelOptions {
  enabled?: boolean
  minWidth?: number
  minHeight?: number
}

interface PanelBox {
  left: number
  top: number
  width: number
  height: number
}

export interface ResizablePanelResult {
  rootRef: RefObject<HTMLDivElement>
  /** 拖动后的内联样式（未拖动时为空对象，沿用 CSS 默认尺寸） */
  style: CSSProperties
  onResizeStart: (edge: ResizeEdge, event: ReactPointerEvent<HTMLDivElement>) => void
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), Math.max(lo, hi))
}

export function useResizablePanel(options: ResizablePanelOptions = {}): ResizablePanelResult {
  const { enabled = true, minWidth = 480, minHeight = 360 } = options
  const rootRef = useRef<HTMLDivElement>(null)
  const [box, setBox] = useState<PanelBox | null>(null)

  const onResizeStart = useCallback(
    (edge: ResizeEdge, event: ReactPointerEvent<HTMLDivElement>) => {
      if (!enabled || event.button !== 0) return
      const root = rootRef.current
      if (!root) return
      event.preventDefault()
      event.stopPropagation()

      const rect = root.getBoundingClientRect()
      const start = {
        mouseX: event.clientX,
        mouseY: event.clientY,
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height
      }
      const maxWidth = Math.max(minWidth, window.innerWidth - 16)
      const maxHeight = Math.max(minHeight, window.innerHeight - 16)

      const onMove = (ev: PointerEvent): void => {
        const dx = ev.clientX - start.mouseX
        const dy = ev.clientY - start.mouseY
        let width = start.width
        let height = start.height
        let left = start.left
        let top = start.top
        if (edge.includes('e')) width = clamp(start.width + dx, minWidth, maxWidth)
        if (edge.includes('s')) height = clamp(start.height + dy, minHeight, maxHeight)
        if (edge.includes('w')) {
          width = clamp(start.width - dx, minWidth, maxWidth)
          left = start.left + (start.width - width)
        }
        if (edge.includes('n')) {
          height = clamp(start.height - dy, minHeight, maxHeight)
          top = start.top + (start.height - height)
        }
        setBox({
          left: Math.round(left),
          top: Math.round(top),
          width: Math.round(width),
          height: Math.round(height)
        })
      }

      const onUp = (): void => {
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
        window.removeEventListener('pointercancel', onUp)
      }

      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
      window.addEventListener('pointercancel', onUp)
    },
    [enabled, minWidth, minHeight]
  )

  const style: CSSProperties = box
    ? {
        position: 'fixed',
        left: box.left,
        top: box.top,
        width: box.width,
        height: box.height,
        maxWidth: 'none',
        maxHeight: 'none',
        margin: 0
      }
    : {}

  return { rootRef, style, onResizeStart }
}
