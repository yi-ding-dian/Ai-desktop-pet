/** 多行输入框：受控 value + 简化的 onValueChange；可选随内容自增高。 */
import {
  useCallback,
  useLayoutEffect,
  useRef,
  type ChangeEvent,
  type MutableRefObject,
  type ReactElement,
  type TextareaHTMLAttributes
} from 'react'
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
  /** 外部需要聚焦/读选区时传入（可选；不传时行为不变） */
  textareaRef?: MutableRefObject<HTMLTextAreaElement | null>
}

export function Textarea({
  value,
  onValueChange,
  onChange,
  className,
  autoGrow = false,
  maxRows = 6,
  rows = 1,
  textareaRef,
  ...rest
}: TextareaProps): ReactElement {
  const ref = useRef<HTMLTextAreaElement | null>(null)
  const assignRef = useCallback(
    (node: HTMLTextAreaElement | null) => {
      ref.current = node
      if (textareaRef) textareaRef.current = node
    },
    [textareaRef]
  )

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
    // 空内容固定一行高（2026-10-20）：不依赖 scrollHeight——布局/字体尚未稳定时它可能
    // 按父容器高度算成多行，导致空输入框一上来就是好几行高（工作模式输入框真机现象）。
    const oneLine = lineHeight + padding + border
    const content = value.length === 0 ? oneLine : Math.max(oneLine, element.scrollHeight)
    element.style.height = `${Math.min(content, max)}px`
    element.style.overflowY = content > max ? 'auto' : 'hidden'
  }, [value, autoGrow, maxRows])

  return (
    <textarea
      {...rest}
      ref={assignRef}
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
