/** 分区骨架：标题 + 说明 + 内容（设置页各分区复用）。 */
import type { ReactElement, ReactNode } from 'react'
import { cx } from '../classnames'

export interface SectionProps {
  title: ReactNode
  /** 分区说明（一句话定位） */
  desc?: ReactNode
  /** 标题右侧的附加操作（可选） */
  actions?: ReactNode
  className?: string
  children: ReactNode
}

export function Section({ title, desc, actions, className, children }: SectionProps): ReactElement {
  return (
    <section className={cx('pui-section', className)}>
      <header className="pui-section-head">
        <div>
          <h2 className="pui-section-title">{title}</h2>
          {desc ? <p className="pui-section-desc">{desc}</p> : null}
        </div>
        {actions ? <div className="pui-section-actions">{actions}</div> : null}
      </header>
      <div className="pui-section-body">{children}</div>
    </section>
  )
}
