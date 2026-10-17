/**
 * 「宠物」分区（settings 域 panels 层）：名字 + 回复气泡自动收起时长。
 * 名字的真身在 system prompt（后端 build_system_prompt 动态注入）——改完聊天时即自称新名。
 * 气泡时长由宠物窗消费：保存后经配置广播即时生效。
 */
import type { ReactElement } from 'react'
import Section from '../components/section'
import { Field, TextField } from '../components/fields'
import type { PanelProps } from './panel-props'

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
