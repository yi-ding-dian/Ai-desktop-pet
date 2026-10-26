/** 数值展示格式化：token、费用、账户余额、工作目录路径（2026-10-26 从 work/format.ts 拆出）。 */

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
  return /^[A-Za-z]:$/.test(parts[0])
    ? `${parts[0]}${sep}…${sep}${tail}`
    : `…${sep}${tail}`
}
