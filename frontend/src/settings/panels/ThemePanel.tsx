/**
 * 「主题」分区（settings 域 panels 层，设计文档 §7.6.4）——三层结构：
 *
 *  - 全部主题：6 套预设（暗夜/墨蓝/紫夜/明亮/暖米/薄荷）+ 跟随系统，预览小卡网格
 *    （背景/面板/强调三色块示意），点选即时生效；
 *  - 自定义配色：4 个核心色选色器（背景/面板/文字/强调），改动**实时预览**
 *    （直接派生应用，不落存储）；其余变量自动派生；
 *  - 我的主题：命名保存（存 localStorage）后成卡；应用 / 删除（删除使用中的 → 回退暗夜）。
 *
 * 无需「保存」按钮：所有主题变更即时生效并跨窗口广播；离开分区（卸载）时若仍在
 * 实时预览，自动恢复正式主题（放弃未保存的草稿色）。
 */
import { useEffect, useRef, useState, type ReactElement } from 'react'
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

/** 「跟随系统」预览卡的斜分示意图（左深右浅，与真实生效一致） */
const SYSTEM_SWATCHES: ReadonlyArray<string> = [
  'linear-gradient(115deg, #12141c 49%, #f2f3f7 51%)',
  'linear-gradient(115deg, #1c1f2a 49%, #ffffff 51%)',
  'linear-gradient(115deg, #a78bfa 49%, #6d4aec 51%)'
]

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
    deleteMyTheme(id) // 内部：删除 +（使用中则回退暗夜）+ 广播
    setMyThemes(readMyThemes())
    setSelection(readThemeSelection())
  }

  // ---------------------------------------------------------------- 渲染

  const activePresetKey = draft === null && selection.kind === 'preset' ? selection.key : null
  const activeCustomId = draft === null && selection.kind === 'custom' ? selection.id : null

  return (
    <Section title="主题" desc="全部主题 / 自定义配色 / 我的主题。即时生效且跨窗口同步，无需保存。">
      {/* 1）全部主题：6 预设 + 跟随系统 */}
      <div className="set-theme-grid" role="radiogroup" aria-label="全部主题">
        {PRESET_THEMES.map((preset) => (
          <button
            key={preset.key}
            type="button"
            role="radio"
            aria-checked={activePresetKey === preset.key}
            className={`theme-card${activePresetKey === preset.key ? ' selected' : ''}`}
            onClick={() => pickPreset(preset.key)}
          >
            <span className="theme-card-swatches" aria-hidden="true">
              <span style={{ background: preset.colors.bg }} />
              <span style={{ background: preset.colors.panel }} />
              <span style={{ background: preset.colors.accent }} />
            </span>
            <span className="theme-card-name">{preset.name}</span>
          </button>
        ))}
        <button
          type="button"
          role="radio"
          aria-checked={activePresetKey === 'system'}
          className={`theme-card${activePresetKey === 'system' ? ' selected' : ''}`}
          onClick={() => pickPreset('system')}
          data-testid="theme-card-system"
        >
          <span className="theme-card-swatches" aria-hidden="true">
            {SYSTEM_SWATCHES.map((background, i) => (
              <span key={i} style={{ background }} />
            ))}
          </span>
          <span className="theme-card-name">跟随系统</span>
        </button>
      </div>

      {/* 2）我的主题：命名保存的自定义配色 */}
      {myThemes.length > 0 ? (
        <>
          <div className="set-theme-group">我的主题</div>
          <div className="set-theme-grid" role="radiogroup" aria-label="我的主题">
            {myThemes.map((theme) => (
              <div key={theme.id} className="theme-card-wrap">
                <button
                  type="button"
                  role="radio"
                  aria-checked={activeCustomId === theme.id}
                  className={`theme-card${activeCustomId === theme.id ? ' selected' : ''}`}
                  onClick={() => pickMyTheme(theme.id)}
                >
                  <span className="theme-card-swatches" aria-hidden="true">
                    <span style={{ background: theme.colors.bg }} />
                    <span style={{ background: theme.colors.panel }} />
                    <span style={{ background: theme.colors.accent }} />
                  </span>
                  <span className="theme-card-name">{theme.name}</span>
                </button>
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
          <button type="button" className="set-btn" onClick={openCustom} data-testid="theme-custom-open">
            基于当前主题调整…
          </button>
          <span className="set-field-hint">
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
          <div className="set-row">
            <TextField
              value={name}
              onValueChange={setName}
              placeholder="给这套配色起个名字（如「暮色」）"
            />
            <button
              type="button"
              className="set-btn"
              disabled={!name.trim()}
              onClick={saveCustom}
              data-testid="theme-custom-save"
            >
              保存为主题
            </button>
            <button type="button" className="set-btn" onClick={closeCustom}>
              收起
            </button>
          </div>
          <span className="set-field-hint">改动实时预览；保存后出现在「我的主题」，可随时应用或删除。</span>
        </div>
      )}

      <p className="set-field-hint">仅影响界面观感；宠物本体的 3D 模型不受影响。</p>
    </Section>
  )
}
