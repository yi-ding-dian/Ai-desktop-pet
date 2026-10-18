/**
 * 窗口标题栏：leading / title / subtitle / actions。
 * 拖动能力由调用方传入（useFramelessMove 的返回值），组件本身不依赖 bridge。
 */
import type { HTMLAttributes, ReactElement, ReactNode } from 'react'
import { cx } from '../classnames'

export interface WindowTitleBarProps extends Omit<HTMLAttributes<HTMLElement>, 'title'> {
  title?: ReactNode
  subtitle?: ReactNode
  leading?: ReactNode
  /** 右侧操作（关闭/工具按钮） */
  actions?: ReactNode
  /** 拖动事件（useFramelessMove() 的返回值原样透传） */
  dragHandlers?: { onPointerDown?: (event: React.PointerEvent<HTMLElement>) => void }
}

export function WindowTitleBar({
  title,
  subtitle,
  leading,
  actions,
  dragHandlers,
  className,
  children,
  ...rest
}: WindowTitleBarProps): ReactElement {
  return (
    <header {...rest} {...dragHandlers} className={cx('pui-titlebar', className)}>
      {leading ? <span className="pui-titlebar-leading">{leading}</span> : null}
      {title ? <span className="pui-titlebar-title">{title}</span> : null}
      {subtitle ? <span className="pui-titlebar-subtitle">{subtitle}</span> : null}
      {children}
      {actions ? <div className="pui-titlebar-actions">{actions}</div> : null}
    </header>
  )
}
