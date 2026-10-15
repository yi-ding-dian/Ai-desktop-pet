/**
 * 向导萌语气泡（§7.6.6）：设置窗打开期间显示在**宠物右眼右上方**的萌语小气泡。
 *
 * 位置（窗口坐标；宠物窗口 400×400，宠物形象容器 208×208 居中、top=34）：
 * 右眼由 glb-model 脸部标定锚点（face/config.ts：eyeR = 脸坐标 x+0.1156，1 世界单位 ≈ 176px
 * @208 容器）换算 ≈ 窗口 (220, 134)；气泡落其右上方（left 226 / top 54，底缘 ~102），
 * 左下角尾巴指向宠物、不遮脸。**改宠物形象/容器尺寸时同步微调 settings-guide.css 的定位值。**
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

/** 萌语池（随机取一条；语气 = "在配置我"的应景语境） */
const GUIDE_LINES: readonly string[] = [
  '选择你的设置，保存好哦~',
  '调好我就更懂你啦',
  '慢慢改，我等你~',
  '设置好了，我会记在心里~'
]

function pickLine(): string {
  return GUIDE_LINES[Math.floor(Math.random() * GUIDE_LINES.length)] ?? GUIDE_LINES[0]
}

export default function SettingsGuideBubble({
  visible,
  containerRef
}: SettingsGuideBubbleProps): ReactElement | null {
  // 初始取池首条：首帧即有内容（effect 晚一拍，避免"先空后填"的闪烁）
  const [line, setLine] = useState<string>(GUIDE_LINES[0])
  // 每次打开（false → true）重新随机一条
  useEffect(() => {
    if (visible) setLine(pickLine())
  }, [visible])

  if (!visible) return null
  return (
    <div className="settings-guide-bubble" ref={containerRef} data-testid="settings-guide-bubble">
      {line}
    </div>
  )
}
