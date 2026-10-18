/**
 * 通用弹窗壳：遮罩 + 对话框（标题 / 内容 / 底栏）+ Esc 栈 + 焦点陷阱。
 *
 * 本轮只提供，暂未接入现有窗口；下一阶段由设置页主题编辑/确认框接入。
 * 约定：遮罩点击默认**不关闭**（防误触），关闭走右上角 × / Esc / 底栏按钮。
 */
import { useRef } from 'react'
import type { ReactElement, ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { cx } from '../classnames'
import { useEscapeStack } from '../hooks/useEscapeStack'
import { useFocusTrap } from '../hooks/useFocusTrap'
import { IconButton } from './Button'

export type ModalSize = 'sm' | 'md' | 'xl'

export interface ModalShellProps {
  open: boolean
  title: ReactNode
  description?: ReactNode
  icon?: ReactNode
  size?: ModalSize
  /** 底部操作区；不传则不渲染底栏 */
  footer?: ReactNode
  /** 点击遮罩是否关闭（默认 false） */
  closeOnMask?: boolean
  /** Esc 是否关闭（默认 true） */
  closeOnEscape?: boolean
  /** 初始焦点元素（默认第一个可聚焦元素） */
  initialFocusRef?: React.RefObject<HTMLElement | null>
  className?: string
  onClose: () => void
  children: ReactNode
}

export function ModalShell({
  open,
  title,
  description,
  icon,
  size = 'md',
  footer,
  closeOnMask = false,
  closeOnEscape = true,
  initialFocusRef,
  className,
  onClose,
  children
}: ModalShellProps): ReactElement | null {
  const dialogRef = useRef<HTMLDivElement | null>(null)
  useEscapeStack(open && closeOnEscape, onClose)
  useFocusTrap(dialogRef, open, initialFocusRef)

  if (!open) return null

  return createPortal(
    <div
      className="pui-modal-mask"
      onMouseDown={(event) => {
        if (!closeOnMask) return
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === 'string' ? title : undefined}
        className={cx('pui-modal', size !== 'md' && `pui-modal-${size}`, className)}
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
      </div>
    </div>,
    document.body
  )
}
