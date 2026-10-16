/**
 * 向导萌语气泡（§7.6.6）：设置窗打开期间显示在**宠物身体右侧**的萌语小气泡。
 *
 * 位置（窗口坐标；宠物窗口 400×400）：向导姿态下宠物"扒"在设置窗底沿（头在窗内、
 * 身垂窗外）——气泡锚定**身体右侧**（窗口 (292, 268) 一带），屏幕坐标落在设置窗
 * 底沿之外——**物理上不遮挡设置窗内容**。
 * （踩坑备忘：v1 锚"右眼右上方"，向导姿态下恰压在设置窗内容区上盖字，用户实反馈
 *  后改到身体侧；改宠物形象/窗口尺寸时同步微调 settings-guide.css 的定位值。）
 *
 * 显示节奏：每次打开设置出现，HOLD_MS 后淡出、FADE_MS 后从 DOM 移除
 * （"它嘱咐完就去忙了"；移除后形状上报自然不含气泡区）。
 *
 * 形状上报（踩坑备忘，同 TeachingBubbles）：X11 setShape 会同时裁剪可见区域——
 * 气泡可见时其容器必须并入 App 的 interactive rects 上报，否则被裁掉。
 * 气泡是**纯视觉物**：pointer-events:none（不进交互区，只进形状），交互与否与形状上报无关。
 */
import { useEffect, useState, type ReactElement, type RefObject } from 'react'
import './settings-guide.css'

interface SettingsGuideBubbleProps {
  /** 显隐（设置窗打开期间）；false 时渲染 null（形状上报自然不含） */
  visible: boolean
  /** App 侧传入：把气泡容器纳入窗口可交互矩形上报（X11 形状裁剪） */
  containerRef?: RefObject<HTMLDivElement>
}

/** 萌语（用户定稿文案，固定一句——不再随机） */
const GUIDE_LINE = '改变你的设置，记得保存哦~'

/** 显示时长（ms）：显示这么久后开始淡出 */
const HOLD_MS = 7000
/** 淡出时长（ms）：与 css 的 transition 时长一致 */
const FADE_MS = 600

export default function SettingsGuideBubble({
  visible,
  containerRef
}: SettingsGuideBubbleProps): ReactElement | null {
  const [fading, setFading] = useState(false)
  const [gone, setGone] = useState(false)

  // 每次打开（false → true）重新计时：先显示 HOLD_MS，再淡出 FADE_MS 后移除
  useEffect(() => {
    if (!visible) {
      setFading(false)
      setGone(false)
      return
    }
    setFading(false)
    setGone(false)
    const hold = window.setTimeout(() => setFading(true), HOLD_MS)
    const remove = window.setTimeout(() => setGone(true), HOLD_MS + FADE_MS)
    return () => {
      window.clearTimeout(hold)
      window.clearTimeout(remove)
    }
  }, [visible])

  if (!visible || gone) return null
  return (
    <div
      className={`settings-guide-bubble${fading ? ' fading' : ''}`}
      ref={containerRef}
      data-testid="settings-guide-bubble"
    >
      {GUIDE_LINE}
    </div>
  )
}
