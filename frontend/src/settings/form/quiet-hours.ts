/**
 * 免打扰时段文本 ⇄ 数组（settings 域 form 层，设计文档 §6.3 `behavior.quiet_hours`）。
 *
 * 后端字段为 `list[str]`，条目形如 `"23:00-07:00"`（本地时间，可跨午夜）。
 * 设置页用**简易文本输入**（第一版）：多条以逗号/分号/空白分隔；空文本 = 无免打扰（关闭该功能）。
 * 解析失败给出可读原因（提交前校验，见 useSettingsController.save）。
 */

/** 单条时段：HH:MM-HH:MM（24 小时制，00:00–23:59） */
const SEGMENT_RE = /^([01]\d|2[0-3]):[0-5]\d-([01]\d|2[0-3]):[0-5]\d$/

/** 多条文本的分隔符（中英文逗号 / 分号 / 空白） */
const SEPARATOR_RE = /[,，;；\s]+/

export interface QuietHoursParseResult {
  ok: boolean
  /** ok=true 时有效：解析出的时段列表（空文本 → 空数组） */
  list: string[]
  /** ok=false 时的原因（可读中文） */
  error: string | null
}

/** 解析文本 → 时段列表（带格式校验） */
export function parseQuietHours(text: string): QuietHoursParseResult {
  const trimmed = text.trim()
  if (!trimmed) return { ok: true, list: [], error: null }

  const segments = trimmed
    .split(SEPARATOR_RE)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)

  for (const seg of segments) {
    if (!SEGMENT_RE.test(seg)) {
      return {
        ok: false,
        list: [],
        error: `「${seg}」格式不对：应形如 23:00-07:00（24 小时制，多条用逗号分隔）`
      }
    }
  }
  return { ok: true, list: segments, error: null }
}

/** 列表 → 文本（回填输入框；空列表 → 空串） */
export function formatQuietHours(list: readonly unknown[]): string {
  const items = list.filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
  return items.join(', ')
}
