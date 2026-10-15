/**
 * 主题体系 v2（设计文档 §7.6.4）——跨窗口共享：设置窗 / 宠物窗 / 黑板窗。
 *
 * 三层结构（对齐用户熟悉的 svn-git 主题范式）：
 *  - 全部主题：6 套预设（暗夜/墨蓝/紫夜/明亮/暖米/薄荷）+ 跟随系统；
 *  - 自定义配色：4 个核心色（bg/panel/text/accent）实时预览，其余变量自动派生（palette.ts）；
 *  - 我的主题：自定义命名保存到 localStorage（pet-my-themes），可应用 / 删除。
 *
 * 机制：
 *  - 持久化：`pet-theme` 存选择（'preset:<key>' | 'custom:<id>'；旧值 'dark'/'light'/'system'
 *    读取时自动迁移）；`pet-my-themes` 存数组 [{id, name, colors}]；
 *  - 应用：applyTheme = 根元素 data-theme（dark|light 基调，决定原生控件配色）+
 *    **内联注入全量 CSS 变量**（预设与自定义统一路径，内联值优先于 CSS 兜底）；
 *  - 跨窗口同步：BroadcastChannel 广播**完整状态**（selection + myThemes），
 *    其他窗口收到即应用（不只 key——删除"正在被别的窗口使用"的自定义也能一致回退）；
 *  - 每个窗口入口调一次 initTheme()（返回清理函数）。
 *
 * 约定：settings.html 的 head 内联脚本做"首帧防闪烁"（按同一存储格式解析基调），
 * 改存储键名/默认值需同步该脚本。
 */
import { deriveThemeVars, toneOf, type ThemeColors } from './palette'
import { findPreset, PRESET_THEMES, type PresetColorKey } from './presets'

export type { ThemeColors } from './palette'
export { PRESET_THEMES, type PresetColorKey, type PresetTheme } from './presets'
export { deriveThemeVars, toHex, luminance } from './palette'

/** 预设 key + system（跟随系统） */
export type PresetKey = PresetColorKey | 'system'

/** 当前主题选择 */
export type ThemeSelection =
  | { kind: 'preset'; key: PresetKey }
  | { kind: 'custom'; id: string }

/** 「我的主题」（命名保存的自定义配色） */
export interface MyTheme {
  id: string
  name: string
  colors: ThemeColors
}

export const THEME_STORAGE_KEY = 'pet-theme'
export const MY_THEMES_STORAGE_KEY = 'pet-my-themes'
/** BroadcastChannel 名（同源多窗口共享） */
export const THEME_CHANNEL_NAME = 'pet-theme'

/** 默认选择（暗夜） */
export const DEFAULT_SELECTION: ThemeSelection = { kind: 'preset', key: 'dark' }

// ---------------------------------------------------------------- 存储（含旧格式迁移）

function isPresetKey(v: unknown): v is PresetKey {
  return (
    v === 'system' || PRESET_THEMES.some((p) => p.key === v)
  )
}

/** 选择 → 存储字符串（'preset:<key>' | 'custom:<id>'） */
export function selectionToRaw(selection: ThemeSelection): string {
  return selection.kind === 'custom' ? `custom:${selection.id}` : `preset:${selection.key}`
}

/** 存储字符串 → 选择（兼容旧值 'dark'/'light'/'system'；非法 → 默认暗夜） */
export function selectionFromRaw(raw: string | null): ThemeSelection {
  const s = (raw ?? '').trim()
  if (!s) return DEFAULT_SELECTION
  if (s.startsWith('preset:')) {
    const key = s.slice('preset:'.length)
    return isPresetKey(key) ? { kind: 'preset', key } : DEFAULT_SELECTION
  }
  if (s.startsWith('custom:')) {
    const id = s.slice('custom:'.length)
    return id ? { kind: 'custom', id } : DEFAULT_SELECTION
  }
  // 旧格式（v1：'dark' | 'light' | 'system'）平滑迁移
  if (isPresetKey(s)) return { kind: 'preset', key: s }
  return DEFAULT_SELECTION
}

export function readThemeSelection(): ThemeSelection {
  try {
    return selectionFromRaw(localStorage.getItem(THEME_STORAGE_KEY))
  } catch {
    return DEFAULT_SELECTION
  }
}

export function writeThemeSelection(selection: ThemeSelection): void {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, selectionToRaw(selection))
  } catch {
    /* localStorage 不可用：仅本次会话内生效 */
  }
}

/** 读「我的主题」列表（非法/损坏 → 空数组） */
export function readMyThemes(): MyTheme[] {
  try {
    const raw = localStorage.getItem(MY_THEMES_STORAGE_KEY)
    if (!raw) return []
    const list = JSON.parse(raw) as unknown
    if (!Array.isArray(list)) return []
    return list.filter(
      (item): item is MyTheme =>
        item !== null &&
        typeof item === 'object' &&
        typeof (item as MyTheme).id === 'string' &&
        typeof (item as MyTheme).name === 'string' &&
        typeof (item as MyTheme).colors === 'object' &&
        (item as MyTheme).colors !== null
    )
  } catch {
    return []
  }
}

function writeMyThemes(list: MyTheme[]): void {
  try {
    localStorage.setItem(MY_THEMES_STORAGE_KEY, JSON.stringify(list))
  } catch {
    /* 同上 */
  }
}

// ---------------------------------------------------------------- 应用

/** 解析选择 → { 基调, 全量变量 }；自定义 id 不存在时回退默认（返回 null 交由调用方处理） */
function resolveTheme(
  selection: ThemeSelection,
  myThemes: MyTheme[]
): { selection: ThemeSelection; tone: 'dark' | 'light'; vars: Record<string, string> } {
  if (selection.kind === 'custom') {
    const hit = myThemes.find((t) => t.id === selection.id)
    if (hit) {
      return { selection, tone: toneOf(hit.colors), vars: deriveThemeVars(hit.colors) }
    }
    // 自定义已不存在（被删除/数据损坏）→ 回退默认
    return resolveTheme(DEFAULT_SELECTION, myThemes)
  }
  const key = selection.key
  if (key === 'system') {
    // 跟随系统：浅 → 明亮（light），深 → 暗夜（dark）
    const light = window.matchMedia('(prefers-color-scheme: light)').matches
    const preset = findPreset(light ? 'light' : 'dark')
    return { selection, tone: light ? 'light' : 'dark', vars: deriveThemeVars(preset.colors) }
  }
  const preset = findPreset(key)
  return { selection, tone: toneOf(preset.colors), vars: deriveThemeVars(preset.colors) }
}

/** 把变量表内联注入根元素（全量覆盖；内联优先于 theme.css 的兜底值） */
function injectVars(vars: Record<string, string>): void {
  const style = document.documentElement.style
  for (const key of Object.keys(vars)) {
    style.setProperty(key, vars[key])
  }
}

/**
 * 应用主题选择（含回退处理）。返回**实际生效**的选择（可能与入参不同：custom 缺失 → 暗夜）。
 * 不在任何存储上留痕迹——写盘由 setThemeSelection 负责。
 */
export function applyThemeSelection(selection: ThemeSelection, myThemes?: MyTheme[]): ThemeSelection {
  const resolved = resolveTheme(selection, myThemes ?? readMyThemes())
  document.documentElement.dataset.theme = resolved.tone
  injectVars(resolved.vars)
  return resolved.selection
}

/** 直接应用一组核心色（自定义编辑器"实时预览"用：不落存储、不广播） */
export function applyThemeColors(colors: ThemeColors): void {
  document.documentElement.dataset.theme = toneOf(colors)
  injectVars(deriveThemeVars(colors))
}

/** 当前生效的核心色（自定义编辑器初值：在此色基础上微调） */
export function currentThemeColors(selection?: ThemeSelection, myThemes?: MyTheme[]): ThemeColors {
  const sel = selection ?? readThemeSelection()
  const themes = myThemes ?? readMyThemes()
  if (sel.kind === 'custom') {
    const hit = themes.find((t) => t.id === sel.id)
    if (hit) return { ...hit.colors }
    return { ...findPreset('dark').colors }
  }
  if (sel.key === 'system') {
    const light = window.matchMedia('(prefers-color-scheme: light)').matches
    return { ...findPreset(light ? 'light' : 'dark').colors }
  }
  return { ...findPreset(sel.key).colors }
}

// ---------------------------------------------------------------- 变更（写存储 + 应用 + 广播）

/** 广播载荷：完整主题状态（不只 key——跨窗删除/回退也能保持一致） */
export interface ThemeChangePayload {
  selection: ThemeSelection
  myThemes: MyTheme[]
}

// BroadcastChannel：模块级单例（懒建；发送给其他窗口，规范上不回发本窗）
let channel: BroadcastChannel | null = null
const subscribers = new Set<(payload: ThemeChangePayload) => void>()

function ensureChannel(): BroadcastChannel | null {
  if (typeof BroadcastChannel === 'undefined') return null
  if (channel) return channel
  try {
    channel = new BroadcastChannel(THEME_CHANNEL_NAME)
    channel.onmessage = (event: MessageEvent): void => {
      const payload = event.data as ThemeChangePayload | null
      if (!payload || typeof payload !== 'object' || !payload.selection) return
      const myThemes = Array.isArray(payload.myThemes) ? payload.myThemes : readMyThemes()
      // 收到即应用（发送方已写 localStorage；这里直接用载荷内容，避免时序问题）
      applyThemeSelection(payload.selection, myThemes)
      for (const cb of [...subscribers]) {
        try {
          cb({ selection: payload.selection, myThemes })
        } catch (err) {
          console.error('[theme] 订阅者抛错：', err)
        }
      }
    }
  } catch {
    channel = null
  }
  return channel
}

function broadcastThemeChange(): void {
  const ch = ensureChannel()
  if (!ch) return
  try {
    ch.postMessage({
      selection: readThemeSelection(),
      myThemes: readMyThemes()
    } satisfies ThemeChangePayload)
  } catch {
    /* 环境不支持：忽略 */
  }
}

/** 切换主题：写存储 + 应用 + 广播 */
export function setThemeSelection(selection: ThemeSelection): void {
  writeThemeSelection(selection)
  applyThemeSelection(selection, readMyThemes())
  broadcastThemeChange()
}

/** 保存「我的主题」：写列表 + 立即选中该主题 + 广播；返回新条目 */
export function saveMyTheme(name: string, colors: ThemeColors): MyTheme {
  const item: MyTheme = {
    id: `my-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    name: name.trim(),
    colors: { ...colors }
  }
  writeMyThemes([...readMyThemes(), item])
  const selection: ThemeSelection = { kind: 'custom', id: item.id }
  writeThemeSelection(selection)
  applyThemeSelection(selection, readMyThemes())
  broadcastThemeChange()
  return item
}

/** 删除「我的主题」；若删除的是当前使用中的 → 回退默认（暗夜）并应用 */
export function deleteMyTheme(id: string): void {
  const list = readMyThemes()
  const next = list.filter((t) => t.id !== id)
  writeMyThemes(next)

  const selection = readThemeSelection()
  if (selection.kind === 'custom' && selection.id === id) {
    writeThemeSelection(DEFAULT_SELECTION)
    applyThemeSelection(DEFAULT_SELECTION, next)
  }
  broadcastThemeChange()
}

/** 订阅主题状态变化（其他窗口的切换/保存/删除；本窗操作请自行同步 UI 状态）；返回取消订阅函数 */
export function subscribeTheme(cb: (payload: ThemeChangePayload) => void): () => void {
  ensureChannel()
  subscribers.add(cb)
  return () => {
    subscribers.delete(cb)
  }
}

// ---------------------------------------------------------------- 初始化

/**
 * 窗口入口初始化（各页面 main 调一次）：
 * - 应用当前选择（顺带完成旧格式迁移的读路径）；
 * - 监听系统配色变化（仅当选择为"跟随系统"时生效）；
 * - 建立 BroadcastChannel 接收通道（其他窗口切换 → 本窗应用 + 通知 UI 订阅者）。
 * 返回清理函数（HMR / 卸载用）。
 */
export function initTheme(): () => void {
  // 旧格式迁移：读到的若是旧值，回写新格式（幂等）
  const selection = readThemeSelection()
  writeThemeSelection(selection)
  applyThemeSelection(selection, readMyThemes())

  const media = window.matchMedia('(prefers-color-scheme: light)')
  const onSystemChange = (): void => {
    const current = readThemeSelection()
    if (current.kind === 'preset' && current.key === 'system') {
      applyThemeSelection(current, readMyThemes())
    }
  }
  media.addEventListener('change', onSystemChange)

  ensureChannel()

  return () => {
    media.removeEventListener('change', onSystemChange)
  }
}
