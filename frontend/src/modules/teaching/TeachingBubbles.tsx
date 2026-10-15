/**
 * 头顶问题气泡（P5 §7.5.1）：课堂目录——用户提过的每个问题一个气泡，教学模式展开态显示。
 *
 * 视觉约定（窗口内布局；与 electron/teaching/geometry.ts 的讲台位无关）：
 * - 绝对定位于窗口顶部居中区（宽 240、从窗口顶 y=4 往下堆叠、每条高 30）；
 * - 最新一条紧贴顶部、往下依次更旧（LIFO）；最多显示 4 条，超出数量显示 "+N" 小徽标；
 * - 容器本体 pointer-events:none（不挡宠物点击/摸头），仅气泡元素自身可点（pointer-events:auto）。
 *
 * 形状上报（踩坑备忘）：可见时必须把容器 DOM rect 并入 App 的 interactive rects 上报——
 * X11 setShape 会同时裁剪可见区域，未上报的部分会被裁掉（曾发生：状态栏隐藏后兔子被裁剪）。
 */
import type { ReactElement, RefObject } from 'react'
import type { TeachingBubbleItem } from './index'

interface TeachingBubblesProps {
  /** 气泡列表（按 push 顺序：旧 → 新；组件展示时取尾部倒序） */
  items: TeachingBubbleItem[]
  /** 显隐（教学模式展开态）；false 不渲染容器（形状上报自然不含） */
  visible: boolean
  /** 点击某条气泡（App 转发 teaching.goto → 黑板跳转到该问题段落） */
  onClick: (localId: string) => void
  /** App 侧传入：把气泡容器纳入窗口可交互矩形上报（X11 形状穿透/裁剪） */
  containerRef?: RefObject<HTMLDivElement>
}

/** 最多可见条数（设计 §7.5.1：最多 4 条 + "+N" 省略） */
const MAX_VISIBLE = 4

export default function TeachingBubbles({
  items,
  visible,
  onClick,
  containerRef
}: TeachingBubblesProps): ReactElement | null {
  if (!visible) return null
  // 最新一条紧贴顶部，往下依次更旧（LIFO 视觉）
  const recent = items.slice(-MAX_VISIBLE).reverse()
  const hiddenCount = items.length - recent.length
  return (
    <div className="teaching-bubbles" ref={containerRef} data-testid="teaching-bubbles">
      {recent.map((item) => (
        <div
          key={item.localId}
          className="teaching-bubble"
          data-testid="teaching-bubble"
          title={item.text}
          onClick={() => onClick(item.localId)}
        >
          {item.text}
        </div>
      ))}
      {hiddenCount > 0 ? (
        <div className="teaching-bubble-more" data-testid="teaching-bubble-more">
          +{hiddenCount}
        </div>
      ) : null}
    </div>
  )
}
