/**
 * 色板派生（shared/theme 纯函数层）：4 个核心色 → 全量 CSS 变量表。
 *
 * 设计（对齐用户熟悉的 svn-git 主题体系"只选几个色、其余自动推导"）：
 * - 用户/预设只给 4 个核心色：bg（背景/主底色，决定明暗基调）/ panel（面板底）/
 *   text（文字/前景）/ accent（强调色）；
 * - 其余变量（悬浮/dim/描边/浮层/气泡/黑板/代码块等 ~40 个）从核心色推导：
 *   不透明混色用 mix()，半透明描边/浮层用 rgba(text|bg, α)，语义色按明暗基调取深浅；
 * - 推导结果是"具体颜色值"（非 color-mix 表达式）——由 shared/theme/index.ts 内联注入
 *   到根元素，优先级最高，且与旧主题切换相互覆盖不留残渣（见 THEME_VAR_KEYS）。
 */

/** 4 个核心色（预设与「我的主题」共用同一结构） */
export interface ThemeColors {
  bg: string
  panel: string
  text: string
  accent: string
}

// ---------------------------------------------------------------- 颜色工具

/** '#rgb' / '#rrggbb' / 'rgb(r,g,b)' / 'rgba(...)' → [r,g,b] */
function rgbOf(color: string): [number, number, number] {
  const s = color.trim()
  if (s.startsWith('#')) {
    const h = s.length === 4 ? s.replace(/#(.)(.)(.)/, '#$1$1$2$2$3$3') : s
    return [
      parseInt(h.slice(1, 3), 16) || 0,
      parseInt(h.slice(3, 5), 16) || 0,
      parseInt(h.slice(5, 7), 16) || 0
    ]
  }
  const m = s.match(/(\d+)\D+(\d+)\D+(\d+)/)
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [0, 0, 0]
}

const h2 = (n: number): string =>
  Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0')

/** 任意 CSS 颜色 → '#rrggbb'（input[type=color] 只认十六进制；回填"当前生效色"用） */
export function toHex(color: string): string {
  const [r, g, b] = rgbOf(color)
  return `#${h2(r)}${h2(g)}${h2(b)}`
}

/** 感知亮度（0=黑，1=白）：决定明暗基调与语义色深浅 */
export function luminance(color: string): number {
  const [r, g, b] = rgbOf(color).map((v) => v / 255) as [number, number, number]
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** a、b 按 t（0-1）混合 → '#rrggbb' */
function mix(a: string, b: string, t: number): string {
  const [r1, g1, b1] = rgbOf(a)
  const [r2, g2, b2] = rgbOf(b)
  return `#${h2(r1 + (r2 - r1) * t)}${h2(g1 + (g2 - g1) * t)}${h2(b1 + (b2 - b1) * t)}`
}

/** 颜色 + alpha → 'rgba(r, g, b, a)'（半透明描边/浮层用；比 color-mix 兼容面更宽） */
function rgba(color: string, alpha: number): string {
  const [r, g, b] = rgbOf(color)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

/** 按背景亮度定明暗基调（同时决定 data-theme 与派生分支） */
export function toneOf(colors: ThemeColors): 'dark' | 'light' {
  return luminance(colors.bg) < 0.5 ? 'dark' : 'light'
}

// ---------------------------------------------------------------- 全量变量派生

/**
 * deriveThemeVars 会写入的全部变量名（固定清单）。
 * 用途：① 切换主题时防御性清理（正常流程下每次都全量覆盖，无需清理）；
 * ② 测试/校验派生覆盖完整（与 theme.css 中的 :root 兜底清单对齐）。
 */
export const THEME_VAR_KEYS: readonly string[] = [
  '--ui-bg',
  '--ui-bg-soft',
  '--ui-panel',
  '--ui-panel-strong',
  '--ui-panel-faint',
  '--ui-fg',
  '--ui-fg-dim',
  '--ui-fg-faint',
  '--ui-accent',
  '--ui-accent-strong',
  '--ui-accent-fg',
  '--ui-accent-soft',
  '--ui-link',
  '--ui-border',
  '--ui-border-soft',
  '--ui-hover',
  '--ui-solid-hover',
  '--ui-input-bg',
  '--ui-input-border',
  '--ui-danger',
  '--ui-success',
  '--ui-shadow',
  '--ui-scrollbar',
  '--ui-overlay',
  '--ui-overlay-strong',
  '--ui-overlay-fg',
  '--ui-code-bg',
  '--ui-code-inline-bg',
  '--ui-code-fg',
  '--chat-user-bg',
  '--chat-user-fg',
  '--chat-assistant-bg',
  '--chat-assistant-fg',
  '--chat-error-bg',
  '--chat-error-fg',
  '--chat-input-bg',
  '--chat-input-fg',
  '--chat-stop-bg',
  '--chat-stop-hover',
  '--bubble-bg',
  '--bubble-fg',
  '--bubble-hover',
  '--bubble-more-bg',
  '--bubble-more-fg',
  '--board-bg'
]

/**
 * 4 核心色 → 全量变量表。
 * 暗色公式参照原「暗夜」主题的观感（上一版硬编码值），浅色参照原「明亮」——
 * 即派生结果与旧主题观感近似；其余预设/自定义共用同一推导，保证一致。
 */
export function deriveThemeVars(colors: ThemeColors): Record<string, string> {
  const { bg, panel, text, accent } = colors
  const dark = toneOf(colors) === 'dark'
  const t = (ratio: number): string => mix(text, bg, ratio) // 文本往 bg 方向淡化

  return {
    // —— 底与面 ——
    '--ui-bg': bg,
    '--ui-bg-soft': mix(bg, text, dark ? 0.035 : 0.04),
    '--ui-panel': panel,
    '--ui-panel-strong': mix(panel, text, dark ? 0.07 : 0.045),
    '--ui-panel-faint': rgba(text, 0.02),

    // —— 文本 ——
    '--ui-fg': text,
    '--ui-fg-dim': t(0.34),
    '--ui-fg-faint': t(0.55),

    // —— 强调 ——
    '--ui-accent': accent,
    '--ui-accent-strong': dark ? mix(accent, '#ffffff', 0.16) : mix(accent, '#000000', 0.12),
    // 强调底上的前景：亮强调用深字、暗强调用白字
    '--ui-accent-fg': luminance(accent) > 0.62 ? '#17121f' : '#ffffff',
    '--ui-accent-soft': rgba(accent, dark ? 0.16 : 0.12),
    '--ui-link': dark ? '#7dd3fc' : '#0369a1',

    // —— 描边与交互 ——
    '--ui-border': rgba(text, dark ? 0.12 : 0.16),
    '--ui-border-soft': rgba(text, dark ? 0.07 : 0.09),
    '--ui-hover': rgba(text, dark ? 0.08 : 0.06),
    '--ui-solid-hover': mix(bg, text, dark ? 0.08 : 0.05),
    '--ui-input-bg': dark ? rgba(text, 0.06) : mix(bg, '#ffffff', 0.6),
    '--ui-input-border': rgba(text, dark ? 0.1 : 0.18),

    // —— 语义（按基调取深浅，保证对比度） ——
    '--ui-danger': dark ? '#ff6b6b' : '#cf3535',
    '--ui-success': dark ? '#4ade80' : '#15803d',
    '--ui-shadow': dark ? '0 14px 44px rgba(0, 0, 0, 0.45)' : '0 12px 32px rgba(17, 24, 39, 0.18)',
    '--ui-scrollbar': rgba(text, dark ? 0.18 : 0.24),

    // —— 浮层（状态栏/调试栏底） ——
    '--ui-overlay': rgba(bg, dark ? 0.85 : 0.92),
    '--ui-overlay-strong': rgba(bg, dark ? 0.95 : 0.97),
    '--ui-overlay-fg': text,

    // —— 代码（黑板正文） ——
    '--ui-code-bg': dark ? mix(panel, '#000000', 0.35) : mix(bg, text, 0.07),
    '--ui-code-inline-bg': rgba(text, dark ? 0.09 : 0.07),
    '--ui-code-fg': dark ? t(0.15) : text,

    // —— 聊天（宠物窗气泡；按基调固定观感，不随预设微调） ——
    '--chat-user-bg': dark ? 'rgba(64, 158, 255, 0.92)' : 'rgba(37, 99, 235, 0.95)',
    '--chat-user-fg': '#ffffff',
    '--chat-assistant-bg': dark ? 'rgba(255, 255, 255, 0.92)' : '#ffffff',
    '--chat-assistant-fg': dark ? '#222222' : text,
    '--chat-error-bg': dark ? 'rgba(220, 80, 80, 0.94)' : 'rgba(203, 54, 54, 0.95)',
    '--chat-error-fg': '#ffffff',
    '--chat-input-bg': dark ? 'rgba(255, 255, 255, 0.92)' : '#ffffff',
    '--chat-input-fg': dark ? '#222222' : text,
    '--chat-stop-bg': dark ? 'rgba(255, 92, 92, 0.92)' : 'rgba(214, 69, 69, 0.95)',
    '--chat-stop-hover': dark ? 'rgba(255, 72, 72, 1)' : 'rgba(190, 48, 48, 1)',

    // —— 头顶问题气泡（跟主题走：底色 = bg 半透明） ——
    '--bubble-bg': rgba(bg, dark ? 0.85 : 0.92),
    '--bubble-fg': text,
    '--bubble-hover': rgba(mix(bg, accent, dark ? 0.25 : 0.08), 0.95),
    '--bubble-more-bg': rgba(bg, dark ? 0.7 : 0.75),
    '--bubble-more-fg': t(0.25),

    // —— 板体（黑板窗；墨蓝/紫夜主题下黑板同调） ——
    '--board-bg': rgba(bg, dark ? 0.92 : 0.95)
  }
}
