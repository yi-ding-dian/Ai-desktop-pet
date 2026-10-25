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

/** 人民币费用：小额保留 4 位，避免一轮几分钱显示成 0.00。 */
export function formatCost(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '¥0'
  if (value < 0.01) return `¥${value.toFixed(4)}`
  if (value < 1) return `¥${value.toFixed(3)}`
  return `¥${value.toFixed(2)}`
}

/** 账户余额：CNY ¥ / USD $ / 其他货币带代码。 */
export function formatMoney(value: number, currency: string): string {
  if (!Number.isFinite(value)) return '—'
  const code = (currency || '').toUpperCase()
  const symbol = code === 'CNY' ? '¥' : code === 'USD' ? '$' : code ? `${code} ` : ''
  return `${symbol}${value.toFixed(2)}`
}

/** 工作目录：太长时保留盘符 + 最后两级（完整路径放 title）。 */
export function formatWorkspacePath(path: string, max = 46): string {
  const raw = (path || '').trim()
  if (raw.length <= max) return raw
  const parts = raw.split(/[\\/]+/).filter(Boolean)
  if (parts.length <= 2) return raw
  const sep = raw.includes('\\') ? '\\' : '/'
  const tail = `${parts[parts.length - 2]}${sep}${parts[parts.length - 1]}`
  return /^[A-Za-z]:$/.test(parts[0]) ? `${parts[0]}${sep}…${sep}${tail}` : `…${sep}${tail}`
}

export function copyText(text: string): void {
  if (!text) return
  try {
    // 主进程写剪贴板（异步）：失败只影响这次复制，不弹错
    void Promise.resolve(getPetBridge().system.copyText(text)).catch(() => undefined)
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
