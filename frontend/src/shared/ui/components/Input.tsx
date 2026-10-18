/** 单行输入框：受控 value + 简化的 onValueChange（也兼容原生 onChange）。 */
import type { ChangeEvent, InputHTMLAttributes, ReactElement } from 'react'
import { cx } from '../classnames'

export interface InputProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'> {
  value: string
  /** 简化回调（只给新值）；与 onChange 二选一即可 */
  onValueChange?: (value: string) => void
  onChange?: (event: ChangeEvent<HTMLInputElement>) => void
}

export function Input({
  value,
  onValueChange,
  onChange,
  className,
  type = 'text',
  spellCheck = false,
  autoComplete = 'off',
  ...rest
}: InputProps): ReactElement {
  return (
    <input
      {...rest}
      type={type}
      value={value}
      spellCheck={spellCheck}
      autoComplete={autoComplete}
      className={cx('pui-input', className)}
      onChange={(event) => {
        onChange?.(event)
        onValueChange?.(event.target.value)
      }}
    />
  )
}
