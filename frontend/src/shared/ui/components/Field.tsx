/** 字段块：标签 + 控件 + 说明/错误（表单统一布局）。 */
import type { ReactElement, ReactNode } from 'react'
import { cx } from '../classnames'

export interface FieldProps {
  label: ReactNode
  /** 标签下方的说明文字 */
  hint?: ReactNode
  /** 校验错误（红色，定位到该字段） */
  error?: string | null
  /** 关联控件 id（可访问性） */
  htmlFor?: string
  className?: string
  children: ReactNode
}

export function Field({ label, hint, error, htmlFor, className, children }: FieldProps): ReactElement {
  return (
    <div className={cx('pui-field', className)}>
      <label className="pui-field-label" htmlFor={htmlFor}>
        {label}
      </label>
      {children}
      {hint ? <span className="pui-field-hint">{hint}</span> : null}
      {error ? (
        <span className="pui-field-error" role="alert">
          {error}
        </span>
      ) : null}
    </div>
  )
}
