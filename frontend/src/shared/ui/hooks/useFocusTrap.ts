/**
 * 弹窗焦点陷阱：打开时把焦点移入弹窗、Tab/Shift+Tab 在内部循环，关闭时还原到打开前的元素。
 * 只用于真正的模态层（ModalShell / ResizableModal）。
 */
import { useEffect } from 'react'
import type { RefObject } from 'react'

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

function focusables(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => el.offsetParent !== null || el === document.activeElement
  )
}

export function useFocusTrap(
  rootRef: RefObject<HTMLElement | null>,
  active: boolean,
  initialFocusRef?: RefObject<HTMLElement | null>
): void {
  useEffect(() => {
    if (!active) return
    const root = rootRef.current
    if (!root) return
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null

    // 首焦点：显式指定 > 第一个可聚焦元素 > 容器自身
    const initial = initialFocusRef?.current ?? focusables(root)[0] ?? root
    if (initial === root && !root.hasAttribute('tabindex')) root.tabIndex = -1
    initial.focus()

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Tab') return
      const list = focusables(root)
      if (list.length === 0) {
        event.preventDefault()
        root.focus()
        return
      }
      const first = list[0]
      const last = list[list.length - 1]
      const current = document.activeElement
      if (event.shiftKey) {
        if (current === first || !root.contains(current)) {
          event.preventDefault()
          last.focus()
        }
      } else if (current === last || !root.contains(current)) {
        event.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('keydown', onKeyDown, true)
      previous?.focus()
    }
  }, [rootRef, active, initialFocusRef])
}
