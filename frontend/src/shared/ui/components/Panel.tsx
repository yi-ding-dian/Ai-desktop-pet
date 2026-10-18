/** 面板表面：card（默认）/ inset / overlay / board。 */
import type { HTMLAttributes, ReactElement } from 'react'
import { cx } from '../classnames'

export type PanelVariant = 'card' | 'inset' | 'overlay' | 'board'

export interface PanelProps extends HTMLAttributes<HTMLDivElement> {
  variant?: PanelVariant
}

export function Panel({ variant = 'card', className, children, ...rest }: PanelProps): ReactElement {
  return (
    <div
      {...rest}
      className={cx('pui-panel', variant !== 'card' && `pui-panel-${variant}`, className)}
    >
      {children}
    </div>
  )
}
