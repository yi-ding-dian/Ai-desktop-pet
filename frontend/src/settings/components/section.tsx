/**
 * 分区骨架（settings 域 components 层）：标题 + 说明 + 内容。
 * 各设置分区共用（数量随功能增加；当前含记忆本）。
 */
import type { ReactElement, ReactNode } from 'react'

interface SectionProps {
  title: string
  /** 分区说明（一句话定位） */
  desc?: string
  children: ReactNode
}

export default function Section({ title, desc, children }: SectionProps): ReactElement {
  return (
    <section className="set-section">
      <header className="set-section-head">
        <h2 className="set-section-title">{title}</h2>
        {desc ? <p className="set-section-desc">{desc}</p> : null}
      </header>
      <div className="set-section-body">{children}</div>
    </section>
  )
}
