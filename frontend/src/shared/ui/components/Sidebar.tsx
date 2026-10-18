/** 侧栏容器：标题 + 导航/内容 + 底部插槽。 */
import type { ReactElement, ReactNode } from 'react'
import { cx } from '../classnames'

export interface SidebarProps {
  title?: ReactNode
  /** 底部插槽（版本号、主题入口等） */
  footer?: ReactNode
  className?: string
  children: ReactNode
}

export function Sidebar({ title, footer, className, children }: SidebarProps): ReactElement {
  return (
    <aside className={cx('pui-sidebar', className)} aria-label={typeof title === 'string' ? title : undefined}>
      {title ? <div className="pui-nav-title">{title}</div> : null}
      {children}
      {footer ? <div className="pui-sidebar-footer">{footer}</div> : null}
    </aside>
  )
}
