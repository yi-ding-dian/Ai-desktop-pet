/**
 * 彩色 SVG 图标库（单文件集中管理——用户定稿："专门用一个文件存，后续在里面加就行了"）。
 *
 * 约定：
 *  - 每个图标 = 一个命名导出的函数组件（不吃主题变量——彩色矢量自带配色，深浅主题下均可读）；
 *  - 统一 viewBox "0 0 24 24"、圆润可爱风（圆头线帽/圆角转折、双色以上的平涂色块）；
 *  - size prop 化（边长 px，默认 16——菜单项内联尺寸）；className 透传便于定位微调；
 *  - 加新图标：照下面任一模板追加一个组件（纯 path/shape 手写，无外部素材），
 *    然后在用它的地方（如 electron/bubble 的菜单载荷 icon 名 → src/bubble 的注册表）登记即可。
 */
import type { ReactElement } from 'react'

/** 图标通用 props */
export interface PetIconProps {
  /** 边长（px；正方形 viewBox 等比缩放），默认 16 */
  size?: number
  /** 附加类名（外边距/定位微调用） */
  className?: string
}

/**
 * 教学（学士帽）：靛紫帽体 + 金色流苏。菜单"开始教学/结束"用。
 */
export function IconTeaching({ size = 16, className }: PetIconProps): ReactElement {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      className={className}
      aria-hidden="true"
    >
      {/* 帽板（菱形平顶，圆角转折） */}
      <path
        d="M12 4.2 L20.6 8.4 L12 12.6 L3.4 8.4 Z"
        fill="#6d5ef0"
        stroke="#6d5ef0"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
      {/* 帽围（下方弧形帽檐） */}
      <path
        d="M7.2 10.8 V14.2 C7.2 15.8 9.4 17.2 12 17.2 C14.6 17.2 16.8 15.8 16.8 14.2 V10.8"
        fill="#8b7cf5"
        stroke="#8b7cf5"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* 流苏：穗绳 + 金色小穗球 */}
      <path
        d="M20.6 8.4 V12.6"
        stroke="#fbbf24"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <circle cx="20.6" cy="13.8" r="1.5" fill="#fbbf24" />
    </svg>
  )
}

/**
 * 工作模式（聊天窗）：青绿窗框 + 三行对话 + 右下角强调圆点。菜单"工作模式"用。
 */
export function IconWork({ size = 16, className }: PetIconProps): ReactElement {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      className={className}
      aria-hidden="true"
    >
      {/* 窗框 */}
      <rect
        x="3.2"
        y="4.4"
        width="17.6"
        height="14"
        rx="3.4"
        fill="#2dd4bf"
        stroke="#2dd4bf"
        strokeWidth="1.2"
      />
      {/* 对话行 */}
      <g stroke="#ecfeff" strokeWidth="1.6" strokeLinecap="round">
        <line x1="7" y1="9" x2="17" y2="9" />
        <line x1="7" y1="12.2" x2="14.4" y2="12.2" />
        <line x1="7" y1="15.4" x2="11.8" y2="15.4" />
      </g>
      {/* 右下强调点 */}
      <circle cx="17.6" cy="15.4" r="1.5" fill="#fbbf24" />
    </svg>
  )
}

/**
 * 设置（齿轮）：天蓝齿轮体 + 圆头齿 + 浅色轴心。菜单"打开设置"用。
 */
export function IconSettings({ size = 16, className }: PetIconProps): ReactElement {
  /** 8 条轮齿（0/45/…/315°；从 r6.6 到 r10.2 的圆头短粗线——远看即齿轮、近看圆润可爱） */
  const teeth = Array.from({ length: 8 }, (_, i) => {
    const a = (i * Math.PI) / 4
    return {
      x1: 12 + Math.cos(a) * 6.6,
      y1: 12 + Math.sin(a) * 6.6,
      x2: 12 + Math.cos(a) * 10.2,
      y2: 12 + Math.sin(a) * 10.2
    }
  })
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      className={className}
      aria-hidden="true"
    >
      <g stroke="#38bdf8" strokeWidth="3" strokeLinecap="round">
        {teeth.map((t, i) => (
          <line key={i} x1={t.x1} y1={t.y1} x2={t.x2} y2={t.y2} />
        ))}
      </g>
      <circle cx="12" cy="12" r="6.4" fill="#38bdf8" />
      <circle cx="12" cy="12" r="2.4" fill="#e0f2fe" />
    </svg>
  )
}

/**
 * 清空（小扫帚）：木色手柄 + 琥珀刷头 + 捆扎带。菜单"清空聊天"用。
 */
export function IconBroom({ size = 16, className }: PetIconProps): ReactElement {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      className={className}
      aria-hidden="true"
    >
      {/* 手柄（从右上斜向左下） */}
      <path d="M19.4 4.6 L12.6 12.4" stroke="#c2854a" strokeWidth="2.2" strokeLinecap="round" />
      {/* 刷头（向左下展开的梯形） */}
      <path
        d="M11.2 11.8 L14.6 13.6 L10.6 20.8 C10 21.9 8.6 22.4 7.6 21.8 L5 20.2 C4 19.6 3.8 18.2 4.4 17.2 Z"
        fill="#f59e0b"
        stroke="#f59e0b"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
      {/* 捆扎带（刷颈接口） */}
      <path d="M9.5 13.6 L12.9 15.4" stroke="#b45309" strokeWidth="1.6" strokeLinecap="round" />
      {/* 扬尘小点（"扫干净了"的灵动感） */}
      <circle cx="14.6" cy="17.6" r="0.9" fill="#fbbf24" />
      <circle cx="16.8" cy="20.4" r="0.7" fill="#fbbf24" />
    </svg>
  )
}

/**
 * 隐藏（弯月 + Zzz）：柔紫月亮 + 浅紫睡眠符号。菜单"隐藏"（把宠物收起来）用。
 */
export function IconSleep({ size = 16, className }: PetIconProps): ReactElement {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      className={className}
      aria-hidden="true"
    >
      {/* 弯月（大圆挖小圆的两段弧） */}
      <path
        d="M15.4 3.4 A8.2 8.2 0 1 0 15.4 20.6 A6.6 6.6 0 0 1 15.4 3.4 Z"
        fill="#8b5cf6"
        stroke="#8b5cf6"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
      {/* Zzz：两枚大小递减的"Z"折线（圆头，超可爱） */}
      <path
        d="M17.4 5.6 h3.4 l-3.4 3.4 h3.4"
        stroke="#a78bfa"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M20.2 2.2 h2.2 l-2.2 2.2 h2.2"
        stroke="#c4b5fd"
        strokeWidth="1.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/*
 * ------------------------------------------------------------------ 加新图标示范
 *
 * 例：加一个"麦克风"图标（说话/语音场景用）——
 *   export function IconMic({ size = 16, className }: PetIconProps): ReactElement {
 *     return (
 *       <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
 *            className={className} aria-hidden="true">
 *         <rect x="9.4" y="3.4" width="5.2" height="10" rx="2.6" fill="#f472b6" />
 *         <path d="M6.4 11.4 a5.6 5.6 0 0 0 11.2 0" stroke="#f472b6"
 *               strokeWidth="1.8" strokeLinecap="round" />
 *         <path d="M12 17 v3.2" stroke="#f472b6" strokeWidth="1.8" strokeLinecap="round" />
 *       </svg>
 *     )
 *   }
 *
 * 登记：使用方按"图标名 → 组件"映射（如 src/bubble/BubbleApp.tsx 的 ICONS 表）。
 */
