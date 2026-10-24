/**
 * 工作窗共用的小工具：时间/token 格式化、复制、外链打开、Markdown 链接拦截。
 * 两个页面（对话流 / 任务页）原先各有一份，统一收在这里。
 */
import type { MouseEvent as ReactMouseEvent } from 'react'
import { getPetBridge } from '../shared/pet-bridge'

export function formatTime(ms: number): string {
  const date = new Date(ms)
  if (Number.isNaN(date.getTime())) return ''
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export function formatTokens(value: number): string {
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`
  return String(value)
}

export function copyText(text: string): void {
  if (!text) return
  try {
    getPetBridge().system.copyText(text)
  } catch {
    /* 旧 preload：静默降级 */
  }
}

export function openExternal(href: string): void {
  try {
    void getPetBridge().system.openExternal(href)
  } catch {
    /* 旧 preload：静默降级 */
  }
}

export function handleMarkdownClick(event: ReactMouseEvent<HTMLDivElement>): void {
  const anchor = (event.target as HTMLElement).closest('a')
  const href = anchor?.getAttribute('href') ?? ''
  if (href.startsWith('http://') || href.startsWith('https://')) {
    event.preventDefault()
    openExternal(href)
  }
}
