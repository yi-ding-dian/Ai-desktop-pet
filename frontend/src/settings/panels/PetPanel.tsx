/**
 * 「宠物」分区（settings 域 panels 层）：名字 + 大小 + 回复气泡自动收起时长。
 * 名字的真身在 system prompt（后端 build_system_prompt 动态注入）——改完聊天时即自称新名。
 * 大小（2026-10-21）为 0.8/0.9/1.0/1.1/1.2 五档：保存后主进程换窗口尺寸、宠物窗换 CSS 变量，
 * 设置向导中即时预览；教学模式/工作模式中不允许改（主进程返回 busy）。
 * 气泡时长由宠物窗消费：保存后经配置广播即时生效。
 */
import type { ReactElement } from 'react'
import Section from '../components/section'
import { Field, SelectField, TextField } from '../components/fields'
import type { PanelProps } from './panel-props'

/** 宠物大小五档（与主进程 window/index.ts 的 PET_SCALE_STEPS、后端 PetConfig.scale 校验一致） */
const PET_SCALE_OPTIONS = [
  { value: '0.8', label: '0.8x（更小）' },
  { value: '0.9', label: '0.9x（稍小）' },
  { value: '1.0', label: '1.0x（标准）' },
  { value: '1.1', label: '1.1x（稍大）' },
  { value: '1.2', label: '1.2x（更大）' }
] as const

interface PetPanelProps extends PanelProps {
  bubbleIdleError: string | null
}

export default function PetPanel({
  form,
  setField,
  bubbleIdleError
}: PetPanelProps): ReactElement {
  return (
    <Section title="宠物" desc="它的身份与聊天展示。">
      <Field label="名字" hint="改完它聊天时会自称新名字">
        <TextField value={form.petName} onValueChange={(v) => setField('petName', v)} placeholder="如 小兔" />
      </Field>
      <Field
        label="宠物大小"
        hint="只缩放兔子本体，输入框与气泡尺寸不变；保存后立即生效。教学模式/工作模式中暂不可改。"
      >
        <SelectField
          value={form.petScale}
          onValueChange={(v) => setField('petScale', v)}
          options={PET_SCALE_OPTIONS}
        />
      </Field>
      <Field
        label="回复气泡自动收起（秒）"
        hint="默认 30；0 = 不自动收起；范围 0 或 5–300。悬浮/选中文字时暂停计时。"
        error={bubbleIdleError}
      >
        <TextField
          type="number"
          min={0}
          max={300}
          step={1}
          value={form.bubbleIdleSeconds}
          onValueChange={(value) => setField('bubbleIdleSeconds', value)}
        />
      </Field>
    </Section>
  )
}
