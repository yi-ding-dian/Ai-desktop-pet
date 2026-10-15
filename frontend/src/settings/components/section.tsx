/**
 * 分区骨架（settings 域 components 层）：标题 + 说明 + 内容。
 * 七个分区（LLM/宠物/声音/行为/记忆/主题/关于）共用。
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
