/** 动画几何与缓动：纯函数（不碰窗口，也不知道流程）。 */
import { BALL_ANIMATION_CONFIG } from './config'
import { petWindowSize, type Point, type Rect, type Size } from '../window'
import { getPetScale } from '../pet-scale'

/** 逐帧间隔（ms）：≈60fps，与 window/move.ts 同款做法（主进程无 rAF，用 setInterval 近似） */
export const FRAME_INTERVAL_MS = 16

/** 流程上下文：看门狗超时置 aborted，各阶段在 await 后检查并提前退出 */
export interface FlowContext {
  aborted: boolean
}

/** 整段睡眠（可被 ctx.aborted 提前唤醒；调用方在 await 后用 assertLive 检查） */
export function sleep(ms: number, ctx: FlowContext): Promise<void> {
  const STEP = 50
  return new Promise((resolve) => {
    const t0 = Date.now()
    const tick = (): void => {
      if (ctx.aborted || Date.now() - t0 >= ms) {
        resolve()
        return
      }
      setTimeout(tick, Math.min(STEP, ms))
    }
    if (ms <= 0) resolve()
    else setTimeout(tick, Math.min(STEP, ms))
  })
}

/** 中止检查：看门狗超时后在各阶段边界抛出，由外层 catch 兜底 */
export function assertLive(ctx: FlowContext): void {
  if (ctx.aborted) throw new Error('fx 动画超时中止（看门狗）')
}

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t

/**
 * 缓动：easeInOut 三次（照参考 magic-flight：u<0.5 ? 4u³ : 1-(-2u+2)³/2）——
 * 飞行的起停都柔和，中段快（"腾空-滑翔-落点"的节奏）。
 */
export function easeInOutCubic(u: number): number {
  return u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2
}

/** 缓动：easeOutCubic（快速冲出、缓慢收尾——显示方向"放大归位"用） */
export function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3)
}

/** 缓动：easeInCubic（缓慢起手、加速离场——退出告别"飞出屏幕"用） */
export function easeInCubic(t: number): number {
  return t * t * t
}

/**
 * 二次贝塞尔"拱线"（照参考 magic-flight）：控制点取起点/终点中点、向上抬 arc，
 * arc = clamp(距离 × arcFactor, arcMin, arcMax)；另把控制点 clamp 在工作区顶部
 * 安全边距之下（防"向上拱"把球拱出屏顶导致中途不可见）。
 * 返回 u∈[0,1] → 屏幕坐标。
 */
export function makeArcPath(from: Point, to: Point, wa: Rect): (u: number) => Point {
  const dist = Math.hypot(to.x - from.x, to.y - from.y)
  const arc = Math.min(BALL_ANIMATION_CONFIG.arcMax, Math.max(BALL_ANIMATION_CONFIG.arcMin, dist * BALL_ANIMATION_CONFIG.arcFactor))
  const mid = {
    x: (from.x + to.x) / 2,
    y: Math.max(wa.y + BALL_ANIMATION_CONFIG.arcTopMargin, (from.y + to.y) / 2 - arc)
  }
  return (u: number) => {
    const v = 1 - u
    return {
      x: v * v * from.x + 2 * v * u * mid.x + u * u * to.x,
      y: v * v * from.y + 2 * v * u * mid.y + u * u * to.y
    }
  }
}

export const centerOf = (r: Rect): Point => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 })

/**
 * 取坐标、把尺寸归一到宠物窗设计尺寸（DIP）。
 * `getBounds()` 在 Windows fractional DPI 下回吐的是舍入值（400→401）；如果把它记为
 * "家"并原样 setBounds 回去，每次隐藏/显示都会再 +1px，宠物窗越撑越高（输入框下沉）。
 * 尺寸取**当前缩放档位**（魔法球动画期间禁止改档位，见 main.applyPetScale）。
 */
export function atDesignSize(r: Rect): Rect {
  const size: Size = petWindowSize(getPetScale())
  return { x: r.x, y: r.y, width: size.width, height: size.height }
}

/** 以 center 为中心的球窗（或缩形态窗口）矩形（整数） */
export function boundsAround(center: Point, width: number, height: number): Rect {
  const w = Math.max(2, Math.round(width))
  const h = Math.max(2, Math.round(height))
  return { x: Math.round(center.x - w / 2), y: Math.round(center.y - h / 2), width: w, height: h }
}

export const rectStr = (r: Rect): string => `${r.x},${r.y} ${r.width}x${r.height}`
export const ptStr = (p: Point): string => `${Math.round(p.x)},${Math.round(p.y)}`
