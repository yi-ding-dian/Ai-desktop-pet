/** 工具栏/底栏：横向排列，可指定对齐方式与分隔线。 */
import type { HTMLAttributes, ReactElement } from 'react'
import { cx } from '../classnames'

export type ToolbarAlign = 'start' | 'between' | 'end'

export interface ToolbarProps extends HTMLAttributes<HTMLDivElement> {
  align?: ToolbarAlign
}

export function Toolbar({ align = 'start', className, children, ...rest }: ToolbarProps): ReactElement {
  return (
    <div
      {...rest}
      className={cx(
        'pui-toolbar',
        align === 'between' && 'pui-toolbar-between',
        align === 'end' && 'pui-toolbar-end',
        className
      )}
    >
      {children}
    </div>
  )
}
