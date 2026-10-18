/**
 * 无边框窗口外壳：铺满窗口的 flex 列容器，背景由变体决定。
 * 透明窗（黑板等）用 plain/board；浮层菜单用 overlay；不透明应用根用 solid。
 */
import type { HTMLAttributes, ReactElement } from 'react'
import { cx } from '../classnames'

export type WindowFrameVariant = 'plain' | 'solid' | 'overlay' | 'board'

export interface WindowFrameProps extends HTMLAttributes<HTMLDivElement> {
  variant?: WindowFrameVariant
}

export function WindowFrame({
  variant = 'plain',
  className,
  children,
  ...rest
}: WindowFrameProps): ReactElement {
  return (
    <div
      {...rest}
      className={cx('pui-window', variant !== 'plain' && `pui-window-${variant}`, className)}
    >
      {children}
    </div>
  )
}
