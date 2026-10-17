/**
 * 「记忆」分区（settings 域 panels 层）：长期记忆开关（memory.enabled）。
 */
import type { ReactElement } from 'react'
import Section from '../components/section'
import { SwitchRow } from '../components/fields'
import type { PanelProps } from './panel-props'

export default function MemoryPanel({ form, setField }: PanelProps): ReactElement {
  return (
    <Section title="记忆" desc="长期记忆（结构化档案 + 规则召回，本地存储）。">
      <SwitchRow
        label="长期记忆"
        hint="它会记住你的偏好与约定，聊天时自然用上"
        checked={form.memoryEnabled}
        onCheckedChange={(v) => setField('memoryEnabled', v)}
      />
    </Section>
  )
}
