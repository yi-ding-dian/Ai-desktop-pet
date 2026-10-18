/**
 * 弹层 Esc 栈：只有**最上层**响应 Esc（嵌套弹窗/气泡不会一次全关）。
 * 监听在 document 捕获阶段，Esc 一律 stopPropagation，不穿透到底层视图。
 */
import { useEffect, useRef } from 'react'

interface Entry {
  id: number
  run: () => void
}

const stack: Entry[] = []
let seq = 0
let listening = false

function onKeyDown(event: KeyboardEvent): void {
  if (event.key !== 'Escape') return
  event.stopPropagation()
  const top = stack[stack.length - 1]
  top?.run()
}

function ensureListener(): void {
  if (listening) return
  document.addEventListener('keydown', onKeyDown, true)
  listening = true
}

function releaseListener(): void {
  if (!listening || stack.length > 0) return
  document.removeEventListener('keydown', onKeyDown, true)
  listening = false
}

/** @param active 是否参与 Esc 栈（弹窗关闭/未打开时 false） */
export function useEscapeStack(active: boolean, handler: () => void): void {
  const handlerRef = useRef(handler)
  handlerRef.current = handler

  useEffect(() => {
    if (!active) return
    const entry: Entry = {
      id: ++seq,
      run: () => handlerRef.current()
    }
    stack.push(entry)
    ensureListener()
    return () => {
      const index = stack.indexOf(entry)
      if (index >= 0) stack.splice(index, 1)
      releaseListener()
    }
  }, [active])
}
