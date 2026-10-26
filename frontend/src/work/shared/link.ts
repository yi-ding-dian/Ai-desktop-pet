/** 外链打开与 Markdown 链接拦截（2026-10-26 从 work/format.ts 拆出）。 */
import type { MouseEvent as ReactMouseEvent } from 'react'
import { getPetBridge } from '../../shared/pet-bridge'

export function openExternal(href: string): void {
  try {
    void getPetBridge().system.openExternal(href)
  } catch {
    /* 旧 preload：静默降级 */
  }
}

/** 消息区点击：命中 http(s) 链接时交给系统浏览器，阻止页面内跳转。 */
export function handleMarkdownClick(event: ReactMouseEvent<HTMLDivElement>): void {
  const anchor = (event.target as HTMLElement).closest('a')
  const href = anchor?.getAttribute('href') ?? ''
  if (href.startsWith('http://') || href.startsWith('https://')) {
    event.preventDefault()
    openExternal(href)
  }
}
