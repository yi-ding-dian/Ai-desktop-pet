/**
 * 主题预设（shared/theme）：8 套配色 + 跟随系统（共 9 个选项；§7.6.4 v2）。
 *
 * 每套只定 4 个核心色（bg/panel/text/accent），其余变量由 palette.ts 的
 * deriveThemeVars 统一派生——预设与「我的主题」走同一条路径，观感一致。
 * 「暗夜 / 明亮」的核心色对齐旧版硬编码值（默认观感不变）。
 * 排序 = 深色组在前、浅色组在后（设置页按此顺序铺卡片）。
 */
import type { ThemeColors } from './palette'

/** 预设配色 key（不含 system——system 是"跟随系统"，由 index.ts 单独解析） */
export type PresetColorKey =
  | 'dark'
  | 'blue'
  | 'violet'
  | 'plum'
  | 'light'
  | 'warm'
  | 'mint'
  | 'sakura'

export interface PresetTheme {
  key: PresetColorKey
  name: string
  /** 深色系 / 浅色系（分组展示用） */
  group: 'dark' | 'light'
  colors: ThemeColors
}

export const PRESET_THEMES: readonly PresetTheme[] = [
  {
    key: 'dark',
    name: '暗夜',
    group: 'dark',
    colors: { bg: '#12141c', panel: '#1c1f2a', text: '#e8eaf1', accent: '#a78bfa' }
  },
  {
    key: 'blue',
    name: '墨蓝',
    group: 'dark',
    colors: { bg: '#0e1726', panel: '#16253a', text: '#dbe7f6', accent: '#38bdf8' }
  },
  {
    key: 'violet',
    name: '紫夜',
    group: 'dark',
    colors: { bg: '#171126', panel: '#241a38', text: '#ece6f9', accent: '#e879f9' }
  },
  {
    // 粉系深色（v2）：深紫红底 + 粉紫强调
    key: 'plum',
    name: '粉黛',
    group: 'dark',
    colors: { bg: '#221326', panel: '#2f1c34', text: '#f3e7f4', accent: '#ef9fd7' }
  },
  {
    key: 'light',
    name: '明亮',
    group: 'light',
    colors: { bg: '#f2f3f7', panel: '#ffffff', text: '#232936', accent: '#6d4aec' }
  },
  {
    key: 'warm',
    name: '暖米',
    group: 'light',
    colors: { bg: '#f7f3ea', panel: '#fffdf8', text: '#3b3226', accent: '#b45309' }
  },
  {
    key: 'mint',
    name: '薄荷',
    group: 'light',
    colors: { bg: '#eef7f4', panel: '#ffffff', text: '#1f3a35', accent: '#0d9488' }
  },
  {
    // 粉系浅色（v2）：浅粉底 + 玫红强调
    key: 'sakura',
    name: '樱粉',
    group: 'light',
    colors: { bg: '#fdf0f4', panel: '#ffffff', text: '#3d2333', accent: '#d6336c' }
  }
]

/**
 * 默认预设 key（§7.6.4 v2：默认主题 = 薄荷）。
 * 单一事实来源：index.ts 的默认选择（无存储/数据损坏时）与 findPreset 的未知 key 兜底共用。
 */
export const DEFAULT_PRESET_KEY: PresetColorKey = 'mint'

/** 按 key 取预设（未知 key 回退默认预设「薄荷」——与无存储时的默认选择一致） */
export function findPreset(key: string): PresetTheme {
  return (
    PRESET_THEMES.find((p) => p.key === key) ??
    PRESET_THEMES.find((p) => p.key === DEFAULT_PRESET_KEY) ??
    PRESET_THEMES[0]
  )
}
