/** 对话流的展示与发送辅助：时间、链接归一化、来源兜底、失效原因文案。 */
import { getPetBridge } from '../../shared/pet-bridge'

/** 消息时间：年月日 时分（本地时区） */
export function formatMessageTime(ms: number): string {
  const date = new Date(ms)
  if (Number.isNaN(date.getTime())) return ''
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** 写系统剪贴板：优先 Electron clipboard（file:// 下比 navigator.clipboard 稳） */
export async function copyTextToClipboard(text: string): Promise<boolean> {
  if (!text) return false
  try {
    await getPetBridge().system.copyText(text)
    return true
  } catch {
    try {
      await navigator.clipboard?.writeText(text)
      return true
    } catch (err) {
      console.warn('[work] 复制失败：', err)
      return false
    }
  }
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname || url
  } catch {
    return url
  }
}

/** URL 去重/匹配：忽略 hash 与末尾斜杠（来源列表与搜索结果常差这一处） */
export function normalizeUrl(value: string): string {
  try {
    const url = new URL(value)
    url.hash = ''
    return url.toString().replace(/\/$/, '')
  } catch {
    return value
  }
}

/** 20261018 / 2026-10-18 / 2026/10/18 → 2026/10/18 */
export function prettyDate(value?: string): string {
  const text = value?.trim() ?? ''
  if (!text) return ''
  const digits = text.replace(/\D/g, '')
  if (digits.length >= 8) {
    return `${digits.slice(0, 4)}/${digits.slice(4, 6)}/${digits.slice(6, 8)}`
  }
  return text
}

/** 历史消息没有 sources 事件时，从“来源”行里尽量抠出标题/日期 */
export function fallbackSource(text: string, url: string): { title: string; date: string } | null {
  const line = text
    .split('\n')
    .find((item) => item.includes(url) || item.includes(url.replace(/\/$/, '')))
  if (line === undefined) return null
  const title = line
    .replace(/^[\s\-*]*(?:\[\d+\]|\d+[.)、）．])\s*/, '')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[—–-]\s*$/, '')
    .trim()
  const dateMatch =
    line.match(/\b(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\b/) ??
    line.match(/\b(20\d{2})(\d{2})(\d{2})\b/)
  const date = dateMatch
    ? `${dateMatch[1]}/${dateMatch[2].padStart(2, '0')}/${dateMatch[3].padStart(2, '0')}`
    : ''
  return { title, date }
}

export function reasonText(reason?: string): string {
  switch (reason) {
    case 'pet-unavailable':
      return '宠物窗口还没准备好，稍后再试～'
    case 'timeout':
      return '发送超时了，检查一下后端连接～'
    case 'bad-request':
      return '这条消息没能发出去，再试一次～'
    default:
      return '发送失败，请稍后再试～'
  }
}
