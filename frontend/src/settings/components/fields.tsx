/**
 * 设置页表单原语（settings 域 components 层）：**薄封装 shared/ui 套件**。
 * 对外导出与属性保持不变，各分区无需感知套件类名；视觉/交互统一由套件维护
 * （.pui-field / .pui-input / .pui-select / .pui-switch）。
 */
import type { ReactElement, ReactNode } from 'react'
import { Field as UiField, Input, Select, SwitchRow as UiSwitchRow } from '../../shared/ui'

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
    <UiField label={label} hint={hint} error={error}>
      {children}
    </UiField>
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
    <Input
      value={value}
      onValueChange={onValueChange}
      placeholder={placeholder}
      type={type}
      disabled={disabled}
      min={min}
      max={max}
      step={step}
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
    <Select value={value} onValueChange={onValueChange} options={options} disabled={disabled} />
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
export function SwitchRow({
  label,
  hint,
  checked,
  onCheckedChange,
  disabled
}: SwitchRowProps): ReactElement {
  return (
    <UiSwitchRow
      label={label}
      hint={hint}
      checked={checked}
      onCheckedChange={onCheckedChange}
      disabled={disabled}
    />
  )
}
