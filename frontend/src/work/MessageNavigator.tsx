/**
 * 右侧消息导航（工作模式，2026-10-18）：每条用户提问一个刻度。
 * 点击滚动到该提问并闪烁；滚动时高亮当前轮次；hover 显示问题预览。
 */
import { useEffect, useRef, useState, type ReactElement } from 'react'
import {
  activeTickId,
  layoutTicks,
  type NavigatorAnchor
} from './navigator'

export interface MessageNavigatorProps {
  anchors: NavigatorAnchor[]
  /** 滚动内容总高（px） */
  contentHeight: number
  /** 滚动区可视高度（px；把 scrollTop 归一化成滚动比例用） */
  viewportHeight: number
  /** 滚动区当前 scrollTop */
  scrollTop: number
  /** id → 问题预览文本 */
  previews: Record<string, string>
  onJump: (id: string) => void
  /** 少于 3 条提问时隐藏（避免噪音） */
  visible: boolean
}

export default function MessageNavigator({
  anchors,
  contentHeight,
  viewportHeight,
  scrollTop,
  previews,
  onJump,
  visible
}: MessageNavigatorProps): ReactElement | null {
  const railRef = useRef<HTMLDivElement>(null)
  const [railHeight, setRailHeight] = useState(0)

  useEffect(() => {
    if (!visible) return
    const element = railRef.current
    if (element === null) return
    const observer = new ResizeObserver((entries) => {
      const height = entries[0]?.contentRect.height ?? 0
      setRailHeight(height)
    })
    observer.observe(element)
    setRailHeight(element.clientHeight)
    return () => observer.disconnect()
  }, [visible])

  if (!visible) return null

  const ticks = layoutTicks(anchors, contentHeight, railHeight)
  const active = activeTickId(ticks, scrollTop, contentHeight, viewportHeight)

  return (
    <div className="work-navigator" ref={railRef} aria-label="历史消息导航">
      {ticks.map((tick) => {
        const preview = previews[tick.id] ?? ''
        return (
          <button
            key={tick.id}
            type="button"
            className={`work-nav-tick${active === tick.id ? ' work-nav-tick-active' : ''}`}
            style={{ top: `${tick.top}px` }}
            aria-label={preview || '跳转到该提问'}
            onClick={() => onJump(tick.id)}
          >
            <span className="work-nav-preview" aria-hidden="true">
              {preview}
            </span>
          </button>
        )
      })}
    </div>
  )
}
