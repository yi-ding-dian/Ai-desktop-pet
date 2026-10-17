/**
 * 「宠物」分区（settings 域 panels 层）：名字。
 * 名字的真身在 system prompt（后端 build_system_prompt 动态注入）——改完聊天时即自称新名。
 */
import type { ReactElement } from 'react'
import Section from '../components/section'
import { Field, TextField } from '../components/fields'
import type { PanelProps } from './panel-props'

export default function PetPanel({ form, setField }: PanelProps): ReactElement {
  return (
    <Section title="宠物" desc="它的身份。">
      <Field label="名字" hint="改完它聊天时会自称新名字">
        <TextField value={form.petName} onValueChange={(v) => setField('petName', v)} placeholder="如 小兔" />
      </Field>
    </Section>
  )
}
