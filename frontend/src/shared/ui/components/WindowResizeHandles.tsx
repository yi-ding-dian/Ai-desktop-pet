/**
 * 八向缩放热区（四边 + 四角）：只负责渲染与光标，手势由调用方注入。
 * 通常配合 useFramelessResize() 使用：
 *
 *   const { onResizeStart } = useFramelessResize()
 *   <WindowFrame>…<WindowResizeHandles onResizeStart={onResizeStart} /></WindowFrame>
 */
import type { PointerEvent as ReactPointerEvent, ReactElement } from 'react'
import type { ResizeEdge } from '../hooks/useFramelessResize'

const EDGES: ReadonlyArray<{ edge: ResizeEdge; label: string }> = [
  { edge: 'n', label: '拖动上缘调整高度' },
  { edge: 's', label: '拖动下缘调整高度' },
  { edge: 'w', label: '拖动左缘调整宽度' },
  { edge: 'e', label: '拖动右缘调整宽度' },
  { edge: 'nw', label: '拖动左上角调整尺寸' },
  { edge: 'ne', label: '拖动右上角调整尺寸' },
  { edge: 'sw', label: '拖动左下角调整尺寸' },
  { edge: 'se', label: '拖动右下角调整尺寸' }
]

export interface WindowResizeHandlesProps {
  onResizeStart: (edge: ResizeEdge, event: ReactPointerEvent<HTMLDivElement>) => void
  disabled?: boolean
}

export function WindowResizeHandles({
  onResizeStart,
  disabled = false
}: WindowResizeHandlesProps): ReactElement {
  return (
    <>
      {EDGES.map(({ edge, label }) => (
        <div
          key={edge}
          className={`pui-resize pui-resize-${edge}`}
          role="separator"
          aria-label={label}
          onPointerDown={(event) => {
            if (!disabled) onResizeStart(edge, event)
          }}
        />
      ))}
    </>
  )
}
