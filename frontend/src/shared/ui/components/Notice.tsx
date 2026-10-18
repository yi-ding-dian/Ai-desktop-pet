/** 提示条：info / success / warning / error（颜色全部来自主题 token）。 */
import type { ReactElement, ReactNode } from 'react'
import { cx } from '../classnames'

export type NoticeKind = 'info' | 'success' | 'warning' | 'error'

export interface NoticeProps {
  kind?: NoticeKind
  /** 右侧附加操作（如"重试"按钮） */
  action?: ReactNode
  className?: string
  children: ReactNode
}

export function Notice({ kind = 'info', action, className, children }: NoticeProps): ReactElement {
  return (
    <div
      className={cx('pui-notice', `pui-notice-${kind}`, className)}
      role={kind === 'error' ? 'alert' : 'status'}
    >
      <div className="pui-notice-text">{children}</div>
      {action}
    </div>
  )
}
