/**
 * 设置页表单原语（settings 域 components 层）：受控、无业务逻辑，供各分区复用。
 * 视觉全部走 settings.css 的 .set-* 类（消费 shared/theme 变量）。
 */
import type { ReactElement, ReactNode } from 'react'

interface FieldProps {
  label: string
  /** 标签下方的说明文字 */
  hint?: ReactNode
  /** 校验错误（红色，定位到该字段） */
  error?: string | null
  children: ReactNode
}

/** 字段块：标签 + 控件 + 说明/错误 */
export function Field({ label, hint, error, children }: FieldProps): ReactElement {
  return (
    <div className="set-field">
      <span className="set-field-label">{label}</span>
      {children}
      {hint ? <span className="set-field-hint">{hint}</span> : null}
      {error ? <span className="set-field-error">{error}</span> : null}
    </div>
  )
}

interface TextFieldProps {
  value: string
  onValueChange: (value: string) => void
  placeholder?: string
  /** 'text'（默认）/ 'password' / 'number' 等 */
  type?: string
  disabled?: boolean
  /** 数值输入框的约束（type='number' 时透传；仍由保存入口做业务校验） */
  min?: number
  max?: number
  step?: number
}

/** 单行文本框（受控） */
export function TextField({
  value,
  onValueChange,
  placeholder,
  type = 'text',
  disabled,
  min,
  max,
  step
}: TextFieldProps): ReactElement {
  return (
    <input
      className="set-input"
      type={type}
      value={value}
      placeholder={placeholder}
      disabled={disabled}
      min={min}
      max={max}
      step={step}
      spellCheck={false}
      autoComplete="off"
      onChange={(e) => onValueChange(e.target.value)}
    />
  )
}

interface SelectFieldProps {
  value: string
  onValueChange: (value: string) => void
  options: ReadonlyArray<{ value: string; label: string }>
  disabled?: boolean
}

/** 下拉框（受控） */
export function SelectField({ value, onValueChange, options, disabled }: SelectFieldProps): ReactElement {
  return (
    <select
      className="set-input set-select"
      value={value}
      disabled={disabled}
      onChange={(e) => onValueChange(e.target.value)}
    >
      {options.map((opt) => (
        <option key={opt.value} value={opt.value}>
          {opt.label}
        </option>
      ))}
    </select>
  )
}

interface SwitchRowProps {
  label: string
  hint?: ReactNode
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  disabled?: boolean
}

/** 开关行：说明在左、拨动开关在右 */
export function SwitchRow({ label, hint, checked, onCheckedChange, disabled }: SwitchRowProps): ReactElement {
  return (
    <div className={`set-switch-row${disabled ? ' set-disabled' : ''}`}>
      <span className="set-switch-text">
        <span className="set-field-label">{label}</span>
        {hint ? <span className="set-field-hint">{hint}</span> : null}
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        className={`set-switch${checked ? ' set-switch-on' : ''}`}
        disabled={disabled}
        onClick={() => onCheckedChange(!checked)}
      >
        <span className="set-switch-knob" />
      </button>
    </div>
  )
}
