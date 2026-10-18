/** 下拉框：options 数组 + 受控值。 */
import type { ReactElement, SelectHTMLAttributes } from 'react'
import { cx } from '../classnames'

export interface SelectOption {
  value: string
  label: string
}

export interface SelectProps
  extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'value' | 'onChange'> {
  value: string
  onValueChange: (value: string) => void
  options: ReadonlyArray<SelectOption>
}

export function Select({
  value,
  onValueChange,
  options,
  className,
  ...rest
}: SelectProps): ReactElement {
  return (
    <select
      {...rest}
      value={value}
      className={cx('pui-input', 'pui-select', className)}
      onChange={(event) => onValueChange(event.target.value)}
    >
      {options.map((opt) => (
        <option key={opt.value} value={opt.value}>
          {opt.label}
        </option>
      ))}
    </select>
  )
}
