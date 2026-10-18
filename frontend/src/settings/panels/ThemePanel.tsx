/**
 * 「主题」分区（settings 域 panels 层，设计文档 §7.6.4 v2）——三层结构：
 *
 *  - 全部主题：8 套预设（暗夜/墨蓝/紫夜/粉黛/明亮/暖米/薄荷/樱粉）+ 跟随系统，预览小卡网格
 *    （色样预览卡：卡内以该主题的 背景/面板/强调 三色做 mini 示意），点选即时生效；
 *  - 自定义配色：4 个核心色选色器（背景/面板/文字/强调），改动**实时预览**
 *    （直接派生应用，不落存储）；其余变量自动派生；
 *  - 我的主题：命名保存（存 localStorage）后成卡；应用 / 删除（删除使用中的 → 回退薄荷）。
 *
 * 无需「保存」按钮：所有主题变更即时生效并跨窗口广播；离开分区（卸载）时若仍在
 * 实时预览，自动恢复正式主题（放弃未保存的草稿色）。
 */
import { useEffect, useRef, useState, type KeyboardEvent, type ReactElement, type ReactNode } from 'react'
import { Button } from '../../shared/ui'
import Section from '../components/section'
import { TextField } from '../components/fields'
import {
  applyThemeColors,
  applyThemeSelection,
  currentThemeColors,
  deleteMyTheme,
  PRESET_THEMES,
  readMyThemes,
  readThemeSelection,
  saveMyTheme,
  setThemeSelection,
  subscribeTheme,
  toHex,
  type MyTheme,
  type PresetKey,
  type ThemeColors,
  type ThemeSelection
} from '../../shared/theme'

/** 自定义编辑器暴露的 4 个核心色（其余 ~40 个变量由 palette.deriveThemeVars 派生） */
const EDITABLE_COLORS: ReadonlyArray<{ key: keyof ThemeColors; label: string }> = [
  { key: 'bg', label: '背景色' },
  { key: 'panel', label: '面板色' },
  { key: 'text', label: '文字色' },
  { key: 'accent', label: '强调色' }
]

/**
 * 色样预览卡（§7.6.4 v2）：卡片内 mini 示意——底色 = 该主题 bg，
 * 内嵌一条面板色块 + 一个强调色圆点（CSS 类见 settings.css 的 .theme-card-preview*）。
 */
function ThemeSwatch({ colors }: { colors: Pick<ThemeColors, 'bg' | 'panel' | 'accent'> }): ReactElement {
  return (
    <span className="theme-card-preview" aria-hidden="true" style={{ background: colors.bg }}>
      <span className="theme-card-preview-panel" style={{ background: colors.panel }} />
      <span className="theme-card-preview-dot" style={{ background: colors.accent }} />
    </span>
  )
}

/** 「跟随系统」预览卡的三色示意（左深右浅斜分，与真实生效的深/浅两套一致） */
const SYSTEM_PREVIEW: Pick<ThemeColors, 'bg' | 'panel' | 'accent'> = {
  bg: 'linear-gradient(115deg, #12141c 49%, #f2f3f7 51%)',
  panel: 'linear-gradient(115deg, #1c1f2a 49%, #ffffff 51%)',
  accent: 'linear-gradient(115deg, #a78bfa 49%, #6d4aec 51%)'
}

/**
 * 主题卡容器（div role=radio，**刻意不用 `<button>`**）。
 *
 * 真机踩坑（2026-10-15）：`<button>` 在 Chromium 131 之前**不能作为 flex/grid 容器
 * 布局其子元素**（子内容被匿名盒包裹、按 inline 布局）——Electron 33（Chromium 130）
 * 下 `.theme-card{display:flex}` 失效：卡内预览块宽度塌成几像素细条（Playwright 的
 * Chromium 151 已修复此行为，故本地无法复现）。改用 div + role/tabIndex/键盘处理，
 * 走标准块布局，130 与 151 行为一致。
 */
function ThemeCard(props: {
  checked: boolean
  onPick: () => void
  testId?: string
  children: ReactNode
}): ReactElement {
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === ' ' || event.key === 'Enter') {
      event.preventDefault()
      props.onPick()
    }
  }
  return (
    <div
      role="radio"
      aria-checked={props.checked}
      tabIndex={0}
      className={`theme-card${props.checked ? ' selected' : ''}`}
      data-testid={props.testId}
      onClick={props.onPick}
      onKeyDown={onKeyDown}
    >
      {props.children}
    </div>
  )
}

export default function ThemePanel(): ReactElement {
  const [selection, setSelection] = useState<ThemeSelection>(() => readThemeSelection())
  const [myThemes, setMyThemes] = useState<MyTheme[]>(() => readMyThemes())
  /** 非 null = 自定义编辑器展开中（当前窗口正在实时预览该草稿色） */
  const [draft, setDraft] = useState<ThemeColors | null>(null)
  const [name, setName] = useState('')
  const previewingRef = useRef(false)

  // 跨窗同步：其他窗口的切换 / 保存 / 删除（本窗操作在下方各自同步 state）
  useEffect(
    () =>
      subscribeTheme((payload) => {
        setSelection(payload.selection)
        setMyThemes(payload.myThemes)
      }),
    []
  )

  // ---- 真机排障探针（仅 dev）：主题卡尺寸 / CSS 命中实测 ----
  // 背景：真机（Electron 33 = Chromium 130）曾出现"卡内预览塌成细条"，Playwright
  // （Chromium 151）同代码正常——本探针打印实测值 + UA（确认浏览器版本差异），
  // 输出转发进主进程日志（/tmp/pet-dev.log，[settings-renderer] 前缀）供真机对照。
  useEffect(() => {
    if (!import.meta.env.DEV) return
    const describe = (node: HTMLElement | null, label: string): string => {
      if (!node) return `${label}: null`
      const s = getComputedStyle(node)
      return (
        `${label}: ${node.offsetWidth}x${node.offsetHeight}` +
        ` display=${s.display} position=${s.position} width=${s.width} height=${s.height}` +
        ` flex=${s.flex} alignSelf=${s.alignSelf}`
      )
    }
    const probe = (): void => {
      const card = document.querySelector<HTMLElement>('.theme-card')
      const grid = document.querySelector<HTMLElement>('.set-theme-grid')
      let rules = 0
      try {
        for (const sheet of document.styleSheets) rules += sheet.cssRules.length
      } catch {
        rules = -1 // 跨域样式表不可读（本项目全部同源，正常不会走到）
      }
      console.log(`[settings][probe] ua=${navigator.userAgent}`)
      console.log(
        `[settings][probe] env: dpr=${devicePixelRatio} inner=${innerWidth}x${innerHeight} sheets=${document.styleSheets.length} rules=${rules}`
      )
      console.log(`[settings][probe] ${describe(grid, 'grid')}`)
      console.log(`[settings][probe] ${describe(card, 'card')}`)
      console.log(
        `[settings][probe] ${describe(card?.querySelector<HTMLElement>('.theme-card-preview') ?? null, 'preview')}`
      )
      console.log(
        `[settings][probe] ${describe(card?.querySelector<HTMLElement>('.theme-card-preview-panel') ?? null, 'panel')}`
      )
    }
    probe()
    const timer = window.setTimeout(probe, 400) // 二次采样（布局稳定后，防字体/滚动条未就绪的首帧值）
    return () => window.clearTimeout(timer)
  }, [])

  // 卸载（切走分区）时若仍在实时预览 → 恢复正式主题（放弃未保存草稿）
  useEffect(
    () => () => {
      if (previewingRef.current) {
        applyThemeSelection(readThemeSelection(), readMyThemes())
      }
    },
    []
  )

  // ---------------------------------------------------------------- 操作

  const finishPreview = (): void => {
    setDraft(null)
    previewingRef.current = false
  }

  const pickPreset = (key: PresetKey): void => {
    finishPreview()
    const next: ThemeSelection = { kind: 'preset', key }
    setThemeSelection(next)
    setSelection(next)
  }

  const pickMyTheme = (id: string): void => {
    finishPreview()
    const next: ThemeSelection = { kind: 'custom', id }
    setThemeSelection(next)
    setSelection(next)
  }

  const openCustom = (): void => {
    const colors = currentThemeColors(selection, myThemes)
    setDraft(colors)
    previewingRef.current = true
  }

  const editColor = (key: keyof ThemeColors, value: string): void => {
    const base = draft ?? currentThemeColors(selection, myThemes)
    const next = { ...base, [key]: value }
    setDraft(next)
    applyThemeColors(next) // 实时预览（不落存储、不广播）
  }

  const closeCustom = (): void => {
    finishPreview()
    applyThemeSelection(readThemeSelection(), readMyThemes())
  }

  const saveCustom = (): void => {
    const trimmed = name.trim()
    if (!trimmed || !draft) return
    const item = saveMyTheme(trimmed, draft) // 内部：存列表 + 选中 + 应用 + 广播
    setSelection({ kind: 'custom', id: item.id })
    setMyThemes(readMyThemes())
    finishPreview()
    setName('')
  }

  const removeMyTheme = (id: string): void => {
    deleteMyTheme(id) // 内部：删除 +（使用中则回退薄荷）+ 广播
    setMyThemes(readMyThemes())
    setSelection(readThemeSelection())
  }

  // ---------------------------------------------------------------- 渲染

  const activePresetKey = draft === null && selection.kind === 'preset' ? selection.key : null
  const activeCustomId = draft === null && selection.kind === 'custom' ? selection.id : null

  return (
    <Section title="主题" desc="全部主题 / 自定义配色 / 我的主题。即时生效且跨窗口同步，无需保存。">
      {/* 1）全部主题：8 预设 + 跟随系统（色样预览卡） */}
      <div className="set-theme-grid" role="radiogroup" aria-label="全部主题">
        {PRESET_THEMES.map((preset) => (
          <ThemeCard
            key={preset.key}
            checked={activePresetKey === preset.key}
            onPick={() => pickPreset(preset.key)}
          >
            <ThemeSwatch colors={preset.colors} />
            <span className="theme-card-name">{preset.name}</span>
          </ThemeCard>
        ))}
        <ThemeCard
          checked={activePresetKey === 'system'}
          onPick={() => pickPreset('system')}
          testId="theme-card-system"
        >
          <ThemeSwatch colors={SYSTEM_PREVIEW} />
          <span className="theme-card-name">跟随系统</span>
        </ThemeCard>
      </div>

      {/* 2）我的主题：命名保存的自定义配色 */}
      {myThemes.length > 0 ? (
        <>
          <div className="set-theme-group">我的主题</div>
          <div className="set-theme-grid" role="radiogroup" aria-label="我的主题">
            {myThemes.map((theme) => (
              <div key={theme.id} className="theme-card-wrap">
                <ThemeCard checked={activeCustomId === theme.id} onPick={() => pickMyTheme(theme.id)}>
                  <ThemeSwatch colors={theme.colors} />
                  <span className="theme-card-name">{theme.name}</span>
                </ThemeCard>
                <button
                  type="button"
                  className="theme-card-del"
                  title={`删除「${theme.name}」`}
                  aria-label={`删除主题「${theme.name}」`}
                  onClick={() => removeMyTheme(theme.id)}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        </>
      ) : null}

      {/* 3）自定义配色：4 核心色实时预览 + 命名保存 */}
      <div className="set-theme-group">自定义配色</div>
      {draft === null ? (
        <div className="set-theme-custom-entry">
          <Button onClick={openCustom} data-testid="theme-custom-open">
            基于当前主题调整…
          </Button>
          <span className="pui-field-hint">
            调 4 个核心色（背景 / 面板 / 文字 / 强调），其余配色自动派生；改动实时预览，满意后命名保存。
          </span>
        </div>
      ) : (
        <div className="set-theme-custom" data-testid="theme-custom-editor">
          {EDITABLE_COLORS.map((field) => (
            <label key={field.key} className="set-color-row">
              <input
                type="color"
                className="set-color-input"
                value={toHex(draft[field.key])}
                onChange={(event) => editColor(field.key, event.target.value)}
                aria-label={field.label}
              />
              <span className="set-color-label">{field.label}</span>
              <span className="set-color-hex">{toHex(draft[field.key])}</span>
            </label>
          ))}
          <div className="pui-row">
            <TextField
              value={name}
              onValueChange={setName}
              placeholder="给这套配色起个名字（如「暮色」）"
            />
            <Button
              disabled={!name.trim()}
              onClick={saveCustom}
              data-testid="theme-custom-save"
            >
              保存为主题
            </Button>
            <Button onClick={closeCustom}>收起</Button>
          </div>
          <span className="pui-field-hint">改动实时预览；保存后出现在「我的主题」，可随时应用或删除。</span>
        </div>
      )}

      <p className="pui-field-hint">仅影响界面观感；宠物本体的 3D 模型不受影响。</p>
    </Section>
  )
}
