/** 开关（role="switch"）与"说明在左、开关在右"的开关行。 */
import type { ReactElement, ReactNode } from 'react'
import { cx } from '../classnames'

export interface SwitchProps {
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  disabled?: boolean
  /** 无可见文字时的可访问名称 */
  label?: string
  className?: string
}

export function Switch({
  checked,
  onCheckedChange,
  disabled,
  label,
  className
}: SwitchProps): ReactElement {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      className={cx('pui-switch', checked && 'pui-is-on', className)}
      onClick={() => onCheckedChange(!checked)}
    >
      <span className="pui-switch-knob" />
    </button>
  )
}

export interface SwitchRowProps extends Omit<SwitchProps, 'label' | 'className'> {
  label: ReactNode
  hint?: ReactNode
  className?: string
}

/** 开关行：说明在左、开关在右 */
export function SwitchRow({
  label,
  hint,
  checked,
  onCheckedChange,
  disabled,
  className
}: SwitchRowProps): ReactElement {
  return (
    <div className={cx('pui-switch-row', disabled && 'pui-is-disabled', className)}>
      <span className="pui-switch-text">
        <span className="pui-field-label">{label}</span>
        {hint ? <span className="pui-field-hint">{hint}</span> : null}
      </span>
      <Switch
        checked={checked}
        onCheckedChange={onCheckedChange}
        disabled={disabled}
        label={typeof label === 'string' ? label : undefined}
      />
    </div>
  )
}
