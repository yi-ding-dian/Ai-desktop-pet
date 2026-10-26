/**
 * 工作窗共用时间工具（2026-10-26）：列表分组、相对时间、时钟时间。
 * 对话左栏 / 任务列表原先各有一份完全相同的实现，统一收在这里。
 */

export interface TimeGroup<T> {
  label: string
  items: T[]
}

/**
 * 按「今天 / 昨天 / 7 天内 / 更早」分组，空组不返回。
 * getTime 取每条记录用于分组的时间戳；now 可注入，便于离线测试。
 */
export function groupByTime<T>(
  items: readonly T[],
  getTime: (item: T) => number,
  now = Date.now()
): TimeGroup<T>[] {
  const current = new Date(now)
  const startOfToday = new Date(
    current.getFullYear(),
    current.getMonth(),
    current.getDate()
  ).getTime()
  const startOfYesterday = startOfToday - 86_400_000
  const week = startOfToday - 6 * 86_400_000
  const buckets: TimeGroup<T>[] = [
    { label: '今天', items: [] },
    { label: '昨天', items: [] },
    { label: '7 天内', items: [] },
    { label: '更早', items: [] }
  ]
  for (const item of items) {
    const at = getTime(item)
    const index = at >= startOfToday ? 0 : at >= startOfYesterday ? 1 : at >= week ? 2 : 3
    buckets[index].items.push(item)
  }
  return buckets.filter((bucket) => bucket.items.length > 0)
}

/**
 * 列表右侧时间：不是当天显示 MM-DD；当天「刚刚 / n分钟前 / HH:MM」。
 * 先判跨天再判相对时间——昨天 23:55 的消息今天 00:05 看不能显示成「10分钟前」。
 */
export function relativeTime(ms: number, now = Date.now()): string {
  const date = new Date(ms)
  const current = new Date(now)
  const pad = (value: number): string => String(value).padStart(2, '0')
  if (
    date.getFullYear() !== current.getFullYear() ||
    date.getMonth() !== current.getMonth() ||
    date.getDate() !== current.getDate()
  ) {
    return `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
  }
  const diff = Math.max(0, now - ms)
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}分钟前`
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** 时钟时间 HH:MM（消息时间戳等固定行使用）；非法时间返回空串。 */
export function formatClockTime(ms: number): string {
  const date = new Date(ms)
  if (Number.isNaN(date.getTime())) return ''
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`
}
