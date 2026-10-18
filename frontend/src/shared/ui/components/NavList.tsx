/** 导航列表：按钮式导航项，带 aria-current。 */
import type { ReactElement, ReactNode } from 'react'
import { cx } from '../classnames'

export interface NavItem<T extends string = string> {
  id: T
  label: ReactNode
  disabled?: boolean
}

export interface NavListProps<T extends string = string> {
  items: ReadonlyArray<NavItem<T>>
  value: T
  onChange: (id: T) => void
  ariaLabel?: string
  className?: string
}

export function NavList<T extends string = string>({
  items,
  value,
  onChange,
  ariaLabel,
  className
}: NavListProps<T>): ReactElement {
  return (
    <nav className={cx('pui-nav', className)} aria-label={ariaLabel}>
      {items.map((item) => {
        const active = item.id === value
        return (
          <button
            key={item.id}
            type="button"
            className={cx('pui-nav-item', active && 'pui-is-active')}
            aria-current={active ? 'page' : undefined}
            disabled={item.disabled}
            onClick={() => onChange(item.id)}
          >
            {item.label}
          </button>
        )
      })}
    </nav>
  )
}
