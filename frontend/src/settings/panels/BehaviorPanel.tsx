/**
 * 「行为」分区（settings 域 panels 层）：自主行为开关 + 主动问候 + 免打扰时段。
 * 免打扰时段（behavior.quiet_hours）用简易文本输入："23:00-07:00"，多条逗号分隔；
 * 留空 = 关闭该功能；提交前校验（错误由控制器 quietHoursError 传入）。
 */
import type { ReactElement } from 'react'
import Section from '../components/section'
import { Field, SwitchRow, TextField } from '../components/fields'
import type { PanelProps } from './common'

interface BehaviorPanelProps extends PanelProps {
  /** 免打扰时段的格式校验错误（保存时产生） */
  quietHoursError: string | null
}

export default function BehaviorPanel({ form, setField, quietHoursError }: BehaviorPanelProps): ReactElement {
  return (
    <Section title="行为" desc="它自己在桌面上活动的方式（P3 自主行为引擎）。">
      <SwitchRow
        label="自主行为"
        hint="空闲时会自己走动、张望、睡觉"
        checked={form.behaviorEnabled}
        onCheckedChange={(v) => setField('behaviorEnabled', v)}
      />
      <SwitchRow
        label="主动问候"
        hint="允许它主动找你说话（提醒 / 问候）"
        checked={form.behaviorProactiveEnabled}
        onCheckedChange={(v) => setField('behaviorProactiveEnabled', v)}
      />
      <Field
        label="免打扰时段"
        hint="格式 23:00-07:00（24 小时制，可跨午夜；多条用逗号分隔）；留空 = 不启用"
        error={quietHoursError}
      >
        <TextField
          value={form.quietHoursText}
          onValueChange={(v) => setField('quietHoursText', v)}
          placeholder="23:00-07:00"
        />
      </Field>
    </Section>
  )
}
