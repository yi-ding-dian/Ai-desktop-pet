/** 加载指示：环形（默认）/ 三点（"思考中"）。 */
import type { ReactElement } from 'react'
import { cx } from '../classnames'

export interface SpinnerProps {
  size?: 'sm' | 'md'
  variant?: 'ring' | 'dots'
  /** 无障碍名称（默认"加载中"） */
  label?: string
  className?: string
}

export function Spinner({
  size = 'md',
  variant = 'ring',
  label = '加载中',
  className
}: SpinnerProps): ReactElement {
  if (variant === 'dots') {
    return (
      <span className={cx('pui-spinner-dots', className)} role="status" aria-label={label}>
        <span />
        <span />
        <span />
      </span>
    )
  }
  return (
    <span
      className={cx('pui-spinner', size === 'sm' && 'pui-spinner-sm', className)}
      role="status"
      aria-label={label}
    />
  )
}
