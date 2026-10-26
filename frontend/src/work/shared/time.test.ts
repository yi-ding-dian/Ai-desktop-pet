/**
 * 时间分组与显示纯函数离线自测（npm run test:work-time）。
 * 固定「现在」为 2026-10-26 12:00，避免结果随运行时间变化；边界日一律用本地时间构造。
 */
import { formatClockTime, groupByTime, relativeTime } from './time'

let pass = 0
const failures: string[] = []
function check(name: string, ok: boolean): void {
  if (ok) pass += 1
  else failures.push(name)
}

const now = new Date(2026, 9, 26, 12, 0, 0).getTime()
const day = 86_400_000
const hour = 3_600_000

// ---------------------------------------------------------------- groupByTime
{
  const items = [
    { id: 'today', at: now - hour },
    { id: 'yesterday', at: now - day },
    { id: 'week', at: now - 6 * day },
    { id: 'older', at: now - 7 * day }
  ]
  const groups = groupByTime(items, (item) => item.at, now)
  check('分组标签顺序', groups.map((group) => group.label).join('/') === '今天/昨天/7 天内/更早')
  check('今天组收当天记录', groups[0]?.items[0]?.id === 'today')
  check('昨天组收昨天记录', groups[1]?.items[0]?.id === 'yesterday')
  check('7 天内收第 6 天', groups[2]?.items[0]?.id === 'week')
  check('更早收第 7 天', groups[3]?.items[0]?.id === 'older')
}
check('空组被过滤', groupByTime([{ at: now }], (item) => item.at, now).length === 1)
check(
  '同组内保持原顺序',
  groupByTime(
    [
      { id: 'a', at: now - hour },
      { id: 'b', at: now - 2 * hour }
    ],
    (item) => item.at,
    now
  )[0]?.items.map((item) => item.id).join(',') === 'a,b'
)

// ---------------------------------------------------------------- relativeTime
check('1 分钟内显示刚刚', relativeTime(now - 30_000, now) === '刚刚')
check('1 小时内显示 n 分钟前', relativeTime(now - 5 * 60_000, now) === '5分钟前')
check(
  '当天超过 1 小时显示时分',
  relativeTime(new Date(2026, 9, 26, 9, 30).getTime(), now) === '09:30'
)
check('跨天显示月-日', relativeTime(new Date(2026, 9, 25, 23, 55).getTime(), now) === '10-25')
check(
  '跨天后即使只差 5 分钟也不显示「n 分钟前」',
  relativeTime(
    new Date(2026, 9, 25, 23, 55).getTime(),
    new Date(2026, 9, 26, 0, 0).getTime()
  ) === '10-25'
)
check('跨年显示月-日', relativeTime(new Date(2025, 11, 31, 20, 0).getTime(), now) === '12-31')

// ---------------------------------------------------------------- formatClockTime
check('时钟时间补零', formatClockTime(new Date(2026, 9, 26, 9, 5).getTime()) === '09:05')
check('非法时间返回空串', formatClockTime(Number.NaN) === '')

console.log(`\n=== work time 离线测试：${pass} 通过 / ${failures.length} 失败 ===`)
if (failures.length > 0) {
  failures.forEach((failure) => console.error(`  ✗ ${failure}`))
  process.exit(1)
}
