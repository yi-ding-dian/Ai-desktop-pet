/**
 * 分区骨架（settings 域 components 层）：**薄封装 shared/ui 的 Section**。
 * 标题 + 说明 + 内容；各设置分区共用，对外 API 不变。
 */
import type { ReactElement, ReactNode } from 'react'
import { Section as UiSection } from '../../shared/ui'

interface SectionProps {
  title: string
  /** 分区说明（一句话定位） */
  desc?: string
  children: ReactNode
}

export default function Section({ title, desc, children }: SectionProps): ReactElement {
  return (
    <UiSection title={title} desc={desc}>
      {children}
    </UiSection>
  )
}
