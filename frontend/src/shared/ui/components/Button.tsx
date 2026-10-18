/** 套件按钮：普通 / 主操作 / 危险 / 幽灵，以及无障碍图标按钮。 */
import type { ButtonHTMLAttributes, ReactElement } from 'react'
import { cx } from '../classnames'

export type ButtonVariant = 'default' | 'primary' | 'danger' | 'ghost'
export type ButtonSize = 'sm' | 'md'

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
  /** 加载中：显示小转圈并禁用（防重复提交） */
  loading?: boolean
}

export function Button({
  variant = 'default',
  size = 'md',
  loading = false,
  disabled,
  className,
  children,
  type = 'button',
  ...rest
}: ButtonProps): ReactElement {
  return (
    <button
      {...rest}
      type={type}
      disabled={disabled || loading}
      className={cx(
        'pui-btn',
        variant !== 'default' && `pui-btn-${variant}`,
        size === 'sm' && 'pui-btn-sm',
        className
      )}
    >
      {loading ? <span className="pui-spinner pui-spinner-sm" aria-hidden="true" /> : null}
      {children}
    </button>
  )
}

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** 必填：图标按钮的可访问名称（同时作为默认 title） */
  label: string
  /** 危险语义悬停色（删除 / 下课等重要操作） */
  danger?: boolean
}

export function IconButton({
  label,
  danger = false,
  className,
  children,
  type = 'button',
  title,
  ...rest
}: IconButtonProps): ReactElement {
  return (
    <button
      {...rest}
      type={type}
      title={title ?? label}
      aria-label={label}
      className={cx('pui-icon-btn', danger && 'pui-icon-btn-danger', className)}
    >
      {children}
    </button>
  )
}
