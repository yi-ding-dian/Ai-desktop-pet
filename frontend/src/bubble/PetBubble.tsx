/**
 * 标准气泡组件（PetBubble）——气泡窗内使用（用户定稿"气泡系统"的标准件：
 * 后续右键菜单、清空确认、说话气泡（场景3）都坐落在它上面，填参数微调、跟随主题）。
 *
 * 形态预设 variant：
 *  - menu：彩色图标 + 文字菜单项（items 驱动；点击回传 item.id）；
 *  - confirm：一句问询 +【确认】【取消】（点击回传 'confirm' / 'cancel'——通用语义 id，
 *    具体业务含义由调用方（主进程动作分发）解释）；
 *  - text：纯文本气泡（说话气泡预留，本期只做基础渲染）。
 *
 * 动画（用户定稿"手来手回"，motion 参数化；本组件只负责**窗内表演**，窗口显隐由主进程经
 * REQUEST_CLOSE/CLOSED 编排）：
 *  - 入场（enter='hand'）：小光点从窗内爪侧（尾部朝向的对面——左下/左上）沿弧线飞到气泡尾处
 *    （ENTER_FLY_MS 140ms）→ 气泡自尾巴处弹性展开（CSS 关键帧 210ms，延迟 130ms 衔接）
 *    + 菜单项 stagger 淡入；总计 ~350ms；
 *  - 退场（exit='hand'）：气泡收拢回尾巴处（EXIT_SHRINK_MS 140ms）→ 光点从该处弧线飞回爪侧
 *    （EXIT_FLY_MS 140ms）→ 回调 onExited（调用方据此回报主进程 hide）；总计 ~280ms；
 *  - 'none'：直接显隐（预留）。
 *
 * 主题：颜色全部吃 shared/theme 变量（--bubble-bg/--bubble-fg 家族——与向导/教学头顶气泡
 * 同族观感、独立类名互不牵连）。尾巴 = 旋转 45° 的小方块（::after，settings-guide.css 手法），
 * 位置由 tail 朝向（down=左下指向宠物 / up=翻向）决定。
 *
 * 尺寸上报：ResizeObserver 观察气泡本体（offsetWidth/Height——不受入场 scale 影响），
 * 加窗内留白常量 PAD（与 bubble.css 定位值、geometry.ts 的 TAIL_INSET_* 三方对齐）经 onSize
 * 回传——主进程据此 setBounds 动态调窗（窗随内容自适应）。
 */
import { useEffect, useRef, type CSSProperties, type ReactElement } from 'react'
import {
  IconBroom,
  IconSettings,
  IconSleep,
  IconTeaching,
  type PetIconProps
} from '../shared/icons'
import type {
  BubbleMenuItemPayload,
  BubbleMotion,
  BubbleTail,
  BubbleVariant
} from '../../electron/ipc/channels'

// ---- 动画节拍（ms；与 bubble.css 的关键帧时长对齐——改则同步） ----
/** 入场：光点飞行时长（气泡弹性展开由 CSS 在 130ms 处启动——到达与绽放重叠衔接） */
const ENTER_FLY_MS = 140
/** 退场：气泡收拢时长（与 css .pet-bubble-closing 动画一致） */
const EXIT_SHRINK_MS = 140
/** 退场：光点飞回时长 */
const EXIT_FLY_MS = 140

/**
 * 气泡窗内固定留白（px；尺寸上报 = 气泡本体 + 本留白）。
 * 与 bubble.css 的 .pet-bubble 定位值（left/bottom 32/12 等）、electron/bubble/geometry.ts
 * 的 TAIL_INSET_X/Y 三方对齐——调外观留白时三处同步。
 */
const PAD = { top: 12, right: 16, bottom: 12, left: 32 } as const

/** 菜单图标注册表（icon 名 → 组件；未知名渲染为无图标——宽容降级）。加图标见 shared/icons 注释 */
const ICONS: Record<string, (p: PetIconProps) => ReactElement> = {
  teaching: IconTeaching,
  settings: IconSettings,
  broom: IconBroom,
  sleep: IconSleep
}

export interface PetBubbleProps {
  /** 形态预设 */
  variant: BubbleVariant
  /** menu：菜单项（id/label/icon 名） */
  items?: BubbleMenuItemPayload[]
  /** confirm/text：文本内容 */
  message?: string
  /** confirm：确认按钮文案（默认「确定」） */
  confirmLabel?: string
  /** confirm：取消按钮文案（默认「取消」） */
  cancelLabel?: string
  /** 尾巴朝向（主进程防出屏摆放给出：down=气泡悬于锚点上方、up=翻向） */
  tail?: BubbleTail
  /** 运动预设（缺省 = hand 手来手回） */
  motion?: BubbleMotion
  /** 退场指令：true 时播退场动画（播毕 onExited；由 BubbleApp 收到主进程 REQUEST_CLOSE 时置位） */
  closing?: boolean
  /** 用户动作（menu 回传 item.id；confirm 回传 'confirm' / 'cancel'） */
  onAction: (id: string) => void
  /** 退场动画播毕（BubbleApp 据此 notifyClosed 主进程） */
  onExited?: () => void
  /** 内容尺寸（含窗内留白；主进程动态调窗/防出屏用） */
  onSize?: (size: { width: number; height: number }) => void
}

/** 光点当前置点（元素本体定位在 (0,0)，用 transform 平移——性能友好） */
function placeDot(dot: HTMLElement, p: { x: number; y: number }): void {
  dot.style.transform = `translate(${Math.round(p.x)}px, ${Math.round(p.y)}px)`
}

/** 缓动：easeInOutQuad（与 window/move.ts 同款——起步/收尾柔和） */
function easeInOutQuad(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2
}

/**
 * 光点沿二次贝塞尔弧线飞行（照 fx 域拱线手法；rAF 驱动）。
 * 控制点向"两端上方"抬起——"从爪子抛上来"的抛物感（灵动不生硬）。返回取消函数。
 */
function flyDot(
  dot: HTMLElement,
  from: { x: number; y: number },
  to: { x: number; y: number },
  ms: number,
  onDone: () => void
): () => void {
  const ctrl = {
    x: from.x + (to.x - from.x) * 0.18,
    y: Math.min(from.y, to.y) - Math.max(16, Math.abs(to.y - from.y) * 0.55)
  }
  let raf = 0
  let cancelled = false
  const t0 = performance.now()
  const tick = (now: number): void => {
    if (cancelled) return
    const u = Math.min(1, (now - t0) / ms)
    const e = easeInOutQuad(u)
    const v = 1 - e
    placeDot(dot, {
      x: v * v * from.x + 2 * v * e * ctrl.x + e * e * to.x,
      y: v * v * from.y + 2 * v * e * ctrl.y + e * e * to.y
    })
    if (u >= 1) {
      onDone()
      return
    }
    raf = requestAnimationFrame(tick)
  }
  placeDot(dot, from)
  raf = requestAnimationFrame(tick)
  return () => {
    cancelled = true
    if (raf) cancelAnimationFrame(raf)
  }
}

export default function PetBubble({
  variant,
  items,
  message,
  confirmLabel = '确定',
  cancelLabel = '取消',
  tail = 'down',
  motion,
  closing = false,
  onAction,
  onExited,
  onSize
}: PetBubbleProps): ReactElement {
  const dotRef = useRef<HTMLDivElement | null>(null)
  const bubbleRef = useRef<HTMLDivElement | null>(null)
  /** 入场飞行取消句柄（退场开始时打断在途入场） */
  const flyCancelRef = useRef<(() => void) | null>(null)
  /** onExited 只回报一次（StrictMode/异常路径防重复） */
  const exitedRef = useRef(false)

  /** 手来手回预设（缺省 motion 也按 hand；'none' 直接显隐） */
  const handEnter = motion?.enter !== 'none'
  const handExit = motion?.exit !== 'none'

  // ---- 入场：光点从爪侧（尾部朝向的对面）弧线飞到气泡尾处；气泡弹性展开由 CSS 承担 ----
  // 只在挂载时播一次（BubbleApp 以 key=session 重挂——补发同载荷不会重播）；tail 后续变化只管样式
  useEffect(() => {
    if (!handEnter) return
    const dot = dotRef.current
    const bubble = bubbleRef.current
    if (!dot || !bubble) return
    const H = window.innerHeight
    const r = bubble.getBoundingClientRect()
    const from = tail === 'up' ? { x: 20, y: 16 } : { x: 20, y: H - 16 }
    const to =
      tail === 'up' ? { x: r.left + 16, y: r.top + 10 } : { x: r.left + 16, y: r.bottom - 10 }
    dot.classList.remove('pet-bubble-dot-off')
    dot.classList.add('pet-bubble-dot-on')
    flyCancelRef.current = flyDot(dot, from, to, ENTER_FLY_MS, () => {
      dot.classList.add('pet-bubble-dot-off')
    })
    return () => {
      flyCancelRef.current?.()
      flyCancelRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 入场只播一次（key 重挂语义）
  }, [])

  // ---- 退场：气泡收拢 → 光点从气泡尾处飞回爪侧 → onExited（调用方回报主进程 hide） ----
  useEffect(() => {
    if (!closing || exitedRef.current) return
    const bubble = bubbleRef.current
    const dot = dotRef.current
    // 非 hand 退场：立即回报（窗口直接隐藏——'none' 预设）
    if (!handExit || !bubble || !dot) {
      const t = window.setTimeout(() => {
        if (!exitedRef.current) {
          exitedRef.current = true
          onExited?.()
        }
      }, 0)
      return () => window.clearTimeout(t)
    }
    // 入场飞行若还在途：立即取消（退场接管光点）
    flyCancelRef.current?.()
    flyCancelRef.current = null

    const H = window.innerHeight
    const r = bubble.getBoundingClientRect()
    const atTail =
      tail === 'up' ? { x: r.left + 16, y: r.top + 10 } : { x: r.left + 16, y: r.bottom - 10 }
    const back = tail === 'up' ? { x: 20, y: 16 } : { x: 20, y: H - 16 }

    let cancelFly: (() => void) | null = null
    let t2 = 0
    const t1 = window.setTimeout(() => {
      // 光点出现在气泡尾处 → 弧线飞回（气泡同步已被 .pet-bubble-closing 收拢——观感"缩回手里"）
      placeDot(dot, atTail)
      dot.classList.remove('pet-bubble-dot-off')
      dot.classList.add('pet-bubble-dot-on')
      cancelFly = flyDot(dot, atTail, back, EXIT_FLY_MS, () => {
        dot.classList.add('pet-bubble-dot-off')
      })
      t2 = window.setTimeout(() => {
        if (!exitedRef.current) {
          exitedRef.current = true
          onExited?.()
        }
      }, EXIT_FLY_MS + 30)
    }, EXIT_SHRINK_MS)
    return () => {
      window.clearTimeout(t1)
      window.clearTimeout(t2)
      cancelFly?.()
    }
  }, [closing, handExit, onExited, tail])

  // ---- 尺寸上报：气泡本体布局尺寸（offsetWidth/Height 不受入场 scale 影响）+ 窗内留白 ----
  useEffect(() => {
    const el = bubbleRef.current
    if (!el || !onSize) return
    let raf = 0
    const report = (): void => {
      if (raf) return
      raf = requestAnimationFrame(() => {
        raf = 0
        onSize({
          width: el.offsetWidth + PAD.left + PAD.right,
          height: el.offsetHeight + PAD.top + PAD.bottom
        })
      })
    }
    const ro = new ResizeObserver(report)
    ro.observe(el)
    report()
    return () => {
      if (raf) cancelAnimationFrame(raf)
      ro.disconnect()
    }
  }, [onSize])

  const closingCls = closing && handExit ? ' pet-bubble-closing' : ''
  const stageCls = `bubble-stage tail-${tail} motion-${handEnter ? 'hand' : 'none'}`

  return (
    <div className={stageCls} data-testid="bubble-stage">
      {/* 光点（手来手回的主角；绝对定位 + transform 弧线飞行） */}
      <div ref={dotRef} className="pet-bubble-dot" aria-hidden="true" />

      <div
        ref={bubbleRef}
        className={`pet-bubble pet-bubble-${variant}${closingCls}`}
        data-testid="pet-bubble"
      >
        {variant === 'menu' ? (
          <div className="pet-bubble-menu" role="menu">
            {(items ?? []).map((item, i) => {
              const Icon = item.icon ? ICONS[item.icon] : undefined
              return (
                <button
                  key={item.id}
                  type="button"
                  role="menuitem"
                  className="pet-bubble-item"
                  style={{ '--i': i } as CSSProperties}
                  data-testid={`pet-bubble-item-${item.id}`}
                  onClick={() => onAction(item.id)}
                >
                  {Icon ? (
                    <span className="pet-bubble-item-icon">
                      <Icon size={16} />
                    </span>
                  ) : null}
                  <span className="pet-bubble-item-label">{item.label}</span>
                </button>
              )
            })}
          </div>
        ) : null}

        {variant === 'confirm' ? (
          <div className="pet-bubble-confirm">
            <div className="pet-bubble-message">{message}</div>
            <div className="pet-bubble-actions">
              <button
                type="button"
                className="pet-bubble-btn pet-bubble-btn-danger"
                data-testid="pet-bubble-confirm"
                onClick={() => onAction('confirm')}
              >
                {confirmLabel}
              </button>
              <button
                type="button"
                className="pet-bubble-btn"
                data-testid="pet-bubble-cancel"
                onClick={() => onAction('cancel')}
              >
                {cancelLabel}
              </button>
            </div>
          </div>
        ) : null}

        {variant === 'text' ? <div className="pet-bubble-message">{message}</div> : null}
      </div>
    </div>
  )
}
