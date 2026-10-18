/** 多行输入框：受控 value + 简化的 onValueChange；可选随内容自增高。 */
import { useLayoutEffect, useRef, type ChangeEvent, type ReactElement, type TextareaHTMLAttributes } from 'react'
import { cx } from '../classnames'

export interface TextareaProps
  extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'value' | 'onChange'> {
  value: string
  /** 简化回调（只给新值）；与 onChange 二选一即可 */
  onValueChange?: (value: string) => void
  onChange?: (event: ChangeEvent<HTMLTextAreaElement>) => void
  /** 随内容增高（工作模式输入条用）；超过 maxRows 行后内部滚动 */
  autoGrow?: boolean
  /** 自增高上限（行数，默认 6） */
  maxRows?: number
}

export function Textarea({
  value,
  onValueChange,
  onChange,
  className,
  autoGrow = false,
  maxRows = 6,
  rows = 1,
  ...rest
}: TextareaProps): ReactElement {
  const ref = useRef<HTMLTextAreaElement>(null)

  useLayoutEffect(() => {
    if (!autoGrow) return
    const element = ref.current
    if (element === null) return
    element.style.height = 'auto'
    const styles = window.getComputedStyle(element)
    const lineHeight = Number.parseFloat(styles.lineHeight) || 20
    const padding =
      (Number.parseFloat(styles.paddingTop) || 0) +
      (Number.parseFloat(styles.paddingBottom) || 0)
    const border =
      (Number.parseFloat(styles.borderTopWidth) || 0) +
      (Number.parseFloat(styles.borderBottomWidth) || 0)
    const max = lineHeight * maxRows + padding + border
    element.style.height = `${Math.min(element.scrollHeight, max)}px`
    element.style.overflowY = element.scrollHeight > max ? 'auto' : 'hidden'
  }, [value, autoGrow, maxRows])

  return (
    <textarea
      {...rest}
      ref={ref}
      rows={rows}
      value={value}
      className={cx('pui-input', 'pui-textarea', className)}
      onChange={(event) => {
        onChange?.(event)
        onValueChange?.(event.target.value)
      }}
    />
  )
}
