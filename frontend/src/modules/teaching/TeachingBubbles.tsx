/**
 * 头顶问题气泡（P5 §7.5.1）：课堂目录——用户提过的每个问题一个气泡，教学模式展开态显示。
 *
 * 视觉约定（窗口内布局；与 electron/teaching/geometry.ts 的讲台位无关）：
 * - **底边锚定**（2026-10-16 用户定稿）：列表**下边缘**固定在**兔耳上方留空隙**
 *   （"消息列表不要挡住兔耳朵"），向上逐条堆叠——条数变化时贴耳的一条永远在原位；
 * - **顺序：旧 → 新（最新的在下面、离兔头最近）**（用户定稿；原实现最新在上已废）；
 * - "+N" 省略徽标放**顶部**（计数被裁掉的更旧条目）；实际可见数 = min(MAX_VISIBLE, 耳上空间容量)；
 * - 容器本体 pointer-events:none（不挡宠物点击/摸头），仅气泡元素自身可点（pointer-events:auto）。
 *
 * 形状上报（踩坑备忘）：可见时必须把容器 DOM rect 并入 App 的 interactive rects 上报——
 * X11 setShape 会同时裁剪可见区域，未上报的部分会被裁掉（曾发生：状态栏隐藏后兔子被裁剪）。
 */
import type { ReactElement, RefObject } from 'react'
import type { TeachingBubbleItem } from './index'

interface TeachingBubblesProps {
  /** 气泡列表（按 push 顺序：旧 → 新；组件展示尾部最近的若干条） */
  items: TeachingBubbleItem[]
  /** 显隐（教学模式展开态）；false 不渲染容器（形状上报自然不含） */
  visible: boolean
  /** 点击某条气泡（App 转发 teaching.goto → 黑板跳转到该问题段落） */
  onClick: (localId: string) => void
  /** App 侧传入：把气泡容器纳入窗口可交互矩形上报（X11 形状穿透/裁剪） */
  containerRef?: RefObject<HTMLDivElement>
}

/** 最多可见条数（设计 §7.5.1：最多 4 条 + "+N" 省略；实际还受耳上空间动态限制） */
const MAX_VISIBLE = 4

/** 宠物窗口逻辑尺寸（px）——空间容量计算用（窗口 270×240，2026-10-20） */
const WINDOW_H = 240
/** 单条高度与堆叠间距（px；与 styles.css 的 .teaching-bubble height:30 / gap:4 对齐——改则同步） */
const ITEM_H = 30
const GAP = 4
/**
 * 耳上空间（px）：列表底边距窗口底 312（= 底边窗内 y≈88——耳顶实测 y≈98 上方留 ~10px 空隙，
 * 2026-10-16 截图量取，样式在 styles.css）；顶部再留 TOP_SAFE 安全边距。
 * 容量由空间推算（当前 ≈2 条 + "+N"）——换兔子形象/窗口尺寸时同步三个常量。
 */
const BUBBLES_BOTTOM = 152
const TOP_SAFE = 6
/** 耳上空间能容纳的条数（至少 1——保证最新一条永远可见） */
const FIT_COUNT = Math.max(
  1,
  Math.floor((WINDOW_H - BUBBLES_BOTTOM - TOP_SAFE + GAP) / (ITEM_H + GAP))
)

export default function TeachingBubbles({
  items,
  visible,
  onClick,
  containerRef
}: TeachingBubblesProps): ReactElement | null {
  if (!visible) return null
  // 取**最新的**若干条（空间受限时保证"最近的对话"可见）；顺序保持 旧→新（最新在下面）
  const shown = items.slice(-Math.min(MAX_VISIBLE, FIT_COUNT))
  const hiddenCount = items.length - shown.length
  return (
    <div className="teaching-bubbles" ref={containerRef} data-testid="teaching-bubbles">
      {hiddenCount > 0 ? (
        <div className="teaching-bubble-more" data-testid="teaching-bubble-more">
          +{hiddenCount}
        </div>
      ) : null}
      {shown.map((item) => (
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
    </div>
  )
}
