/**
 * 「关于」分区（settings 域 panels 层）：应用版本 + 重启应用。
 * 版本来自 bridge backend.getSnapshot().appVersion；重启走 bridge app.restart()（Agent B 实现，可选链容错）。
 */
import type { ReactElement } from 'react'
import Section from '../components/section'

interface AboutPanelProps {
  appVersion: string
  onRestart: () => void
}

export default function AboutPanel({ appVersion, onRestart }: AboutPanelProps): ReactElement {
  return (
    <Section title="关于" desc="AI 桌面宠物">
      <div className="set-about-row">
        <span className="set-field-label">应用版本</span>
        <span className="set-about-value">{appVersion || '—'}</span>
      </div>
      <div className="set-row set-row-top">
        <button type="button" className="set-btn" onClick={onRestart}>
          重启应用
        </button>
        <span className="set-field-hint">
          部分设置（如键位改动）需要重启后生效；重启不会丢失已保存的配置。
        </span>
      </div>
    </Section>
  )
}
