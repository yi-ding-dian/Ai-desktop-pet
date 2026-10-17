/**
 * 「声音」分区（settings 域 panels 层）：播报开关 + 音色。
 * 音色字段对应 config.toml `[voice].voice`（Edge TTS 的 ShortName）；
 * 选项为内置常见中文音色（Provider 支持直接填字符串，列表外的值也能用）。
 */
import { useMemo, type ReactElement } from 'react'
import Section from '../components/section'
import { Field, SelectField, SwitchRow } from '../components/fields'
import type { PanelProps } from './panel-props'

/** 内置常见 Edge TTS 中文音色（ShortName；后端 provider=edge） */
const EDGE_VOICES: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'zh-CN-XiaoxiaoNeural', label: '晓晓 · 女声（默认）' },
  { value: 'zh-CN-XiaoyiNeural', label: '晓伊 · 女声' },
  { value: 'zh-CN-YunxiNeural', label: '云希 · 男声' },
  { value: 'zh-CN-YunjianNeural', label: '云健 · 男声' },
  { value: 'zh-CN-YunyangNeural', label: '云扬 · 男声（播报）' },
  { value: 'zh-CN-YunxiaNeural', label: '云夏 · 少年' },
  { value: 'zh-CN-liaoning-XiaobeiNeural', label: '晓北 · 东北话' },
  { value: 'zh-CN-shaanxi-XiaoniNeural', label: '晓妮 · 陕西话' },
  { value: 'zh-HK-HiuMaanNeural', label: '曉曼 · 粤语（女）' },
  { value: 'zh-TW-HsiaoChenNeural', label: '曉臻 · 台湾（女）' }
]

const DEFAULT_VOICE = 'zh-CN-XiaoxiaoNeural'

export default function VoicePanel({ form, setField }: PanelProps): ReactElement {
  const voiceOptions = useMemo(() => {
    const base = [...EDGE_VOICES]
    if (form.voiceName && !base.some((o) => o.value === form.voiceName)) {
      // 手改过 config.toml 的自定义音色：补一项兜底，避免下拉丢失当前值
      base.unshift({ value: form.voiceName, label: `${form.voiceName}（当前）` })
    }
    return base
  }, [form.voiceName])

  return (
    <Section title="声音" desc="回复语音播报（Edge TTS，免费无需配置）。">
      <SwitchRow
        label="语音播报"
        hint="关闭后只显示文字，不再出声"
        checked={form.voiceEnabled}
        onCheckedChange={(v) => setField('voiceEnabled', v)}
      />
      <Field label="音色" hint="来自微软 Edge TTS 的中文声音列表">
        <SelectField
          value={form.voiceName || DEFAULT_VOICE}
          onValueChange={(v) => setField('voiceName', v)}
          options={voiceOptions}
        />
      </Field>
    </Section>
  )
}
