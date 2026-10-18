/** 空状态：图标 + 主文案 + 说明 + 可选操作。 */
import type { ReactElement, ReactNode } from 'react'
import { cx } from '../classnames'

export interface EmptyStateProps {
  /** emoji / 小图标 */
  icon?: ReactNode
  title?: ReactNode
  hint?: ReactNode
  action?: ReactNode
  /** 撑满容器高度（滚动区里的整页空态） */
  fill?: boolean
  className?: string
}

export function EmptyState({
  icon,
  title,
  hint,
  action,
  fill = false,
  className
}: EmptyStateProps): ReactElement {
  return (
    <div className={cx('pui-empty', fill && 'pui-empty-fill', className)}>
      {icon ? (
        <div className="pui-empty-icon" aria-hidden="true">
          {icon}
        </div>
      ) : null}
      {title ? <div className="pui-empty-title">{title}</div> : null}
      {hint ? <div className="pui-empty-hint">{hint}</div> : null}
      {action}
    </div>
  )
}
