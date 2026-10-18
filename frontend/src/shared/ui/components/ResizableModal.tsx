/**
 * 可拖拽改尺寸的弹窗（与 ModalShell 同一外观；本轮暂不接线）。
 * 八向缩放语义与窗口一致：只动被拖的边、对边固定；首次拖动后固定左上角。
 */
import { createPortal } from 'react-dom'
import type { PointerEvent as ReactPointerEvent, ReactElement, ReactNode, RefObject } from 'react'
import { cx } from '../classnames'
import { useEscapeStack } from '../hooks/useEscapeStack'
import { useFocusTrap } from '../hooks/useFocusTrap'
import { useResizablePanel } from '../hooks/useResizablePanel'
import type { ResizeEdge } from '../hooks/useFramelessResize'
import { IconButton } from './Button'
import { WindowResizeHandles } from './WindowResizeHandles'

export interface ResizableModalProps {
  open: boolean
  title: ReactNode
  description?: ReactNode
  icon?: ReactNode
  defaultWidth?: number
  defaultHeight?: number
  minWidth?: number
  minHeight?: number
  footer?: ReactNode
  closeOnEscape?: boolean
  initialFocusRef?: RefObject<HTMLElement | null>
  className?: string
  onClose: () => void
  children: ReactNode
}

export function ResizableModal({
  open,
  title,
  description,
  icon,
  defaultWidth = 560,
  defaultHeight,
  minWidth = 480,
  minHeight = 360,
  footer,
  closeOnEscape = true,
  initialFocusRef,
  className,
  onClose,
  children
}: ResizableModalProps): ReactElement | null {
  const panel = useResizablePanel({ minWidth, minHeight })
  const dialogRef = panel.rootRef
  useEscapeStack(open && closeOnEscape, onClose)
  useFocusTrap(dialogRef, open, initialFocusRef)

  if (!open) return null

  const onResizeStart = (edge: ResizeEdge, event: ReactPointerEvent<HTMLDivElement>): void => {
    panel.onResizeStart(edge, event)
  }

  return createPortal(
    <div className="pui-modal-mask">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === 'string' ? title : undefined}
        className={cx('pui-modal', 'pui-modal-resizable', className)}
        style={{ width: defaultWidth, height: defaultHeight, ...panel.style }}
      >
        <div className="pui-modal-header">
          {icon ? <span className="pui-modal-icon">{icon}</span> : null}
          <span className="pui-modal-title">{title}</span>
          <IconButton label="关闭" onClick={onClose}>
            ✕
          </IconButton>
        </div>
        {description ? <p className="pui-modal-desc">{description}</p> : null}
        <div className="pui-modal-body">{children}</div>
        {footer ? <div className="pui-modal-footer">{footer}</div> : null}
        <WindowResizeHandles onResizeStart={onResizeStart} />
      </div>
    </div>,
    document.body
  )
}
