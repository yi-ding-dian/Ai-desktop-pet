/** 动画原子：窗口缓动、沿拱线飞行、捕获/释放/淡出（hide/show/relocate 共用）。 */
import type { BrowserWindow } from 'electron'
import { BALL_ANIMATION_CONFIG } from './config'
import {
  FRAME_INTERVAL_MS,
  boundsAround,
  centerOf,
  easeInOutCubic,
  easeOutCubic,
  lerp,
  makeArcPath,
  sleep,
  type FlowContext
} from './math'
import { sendCommand, sendPetReaction } from './window'
import type { Point, Rect, Size } from '../window'

/**
 * 逐帧缓动窗口 bounds（位置与尺寸同时插值）。
 * @param ease    原始进度 p∈[0,1] → 缓动进度
 * @param frameAt 缓动进度 e∈[0,1] → 本帧 bounds
 * 注：动画期间 fx 流程独占窗口操作（锁保证），不做抢占/取消（看门狗中止时提前退出）。
 */
export function animateWindowBounds(
  win: BrowserWindow,
  durationMs: number,
  ease: (p: number) => number,
  frameAt: (e: number) => Rect,
  ctx: FlowContext
): Promise<void> {
  return new Promise((resolve) => {
    if (win.isDestroyed() || durationMs <= 0) {
      if (!win.isDestroyed()) win.setBounds(frameAt(1))
      resolve()
      return
    }
    const t0 = Date.now()
    const timer = setInterval(() => {
      if (ctx.aborted || win.isDestroyed()) {
        clearInterval(timer)
        resolve()
        return
      }
      const p = Math.min(1, (Date.now() - t0) / durationMs)
      win.setBounds(frameAt(ease(p)))
      if (p >= 1) {
        clearInterval(timer)
        resolve()
      }
    }, FRAME_INTERVAL_MS)
  })
}

/**
 * 球窗沿拱线从 from 飞到 to（二次贝塞尔拱线）。
 * @param ease 进度缓动：默认 easeInOutCubic；退出告别传 easeInCubic（加速离场）
 */
export function flyBallArc(
  ball: BrowserWindow,
  from: Point,
  to: Point,
  wa: Rect,
  durationMs: number,
  ctx: FlowContext,
  ease: (p: number) => number = easeInOutCubic
): Promise<void> {
  const path = makeArcPath(from, to, wa)
  const size = BALL_ANIMATION_CONFIG.ballWindowSize
  return animateWindowBounds(
    ball,
    durationMs,
    ease,
    (e) => boundsAround(path(e), size, size),
    ctx
  )
}

/**
 * 回程：球窗与缩小态的宠物窗沿**同一条拱线**同步飞行（单计时循环同时 setBounds——
 * 双计时器会有 1 帧级 jitter，高速段会看出球与宠物错位）。
 */
export function flyBothArc(
  ball: BrowserWindow,
  pet: BrowserWindow,
  from: Point,
  to: Point,
  wa: Rect,
  petSize: Size,
  durationMs: number,
  ctx: FlowContext
): Promise<void> {
  const path = makeArcPath(from, to, wa)
  const size = BALL_ANIMATION_CONFIG.ballWindowSize
  return new Promise((resolve) => {
    if (durationMs <= 0 || ball.isDestroyed()) {
      resolve()
      return
    }
    const t0 = Date.now()
    const timer = setInterval(() => {
      if (ctx.aborted || ball.isDestroyed()) {
        clearInterval(timer)
        resolve()
        return
      }
      const p = Math.min(1, (Date.now() - t0) / durationMs)
      const c = path(easeInOutCubic(p))
      ball.setBounds(boundsAround(c, size, size))
      if (!pet.isDestroyed()) pet.setBounds(boundsAround(c, petSize.width, petSize.height))
      if (p >= 1) {
        clearInterval(timer)
        resolve()
      }
    }, FRAME_INTERVAL_MS)
  })
}

/**
 * 球窗从托盘锚点起飞（空载或载宠物剪影）沿拱线飞抵某中心坐标（flightMs）。
 * 去程（空载捕获）与回程/显示（载宠）共用；调用方负责后续阶段的指令与断言。
 */
export async function flyBallFromAnchor(
  ball: BrowserWindow,
  anchor: Point,
  to: Point,
  wa: Rect,
  cargo: boolean,
  ctx: FlowContext
): Promise<void> {
  ball.setBounds(boundsAround(anchor, BALL_ANIMATION_CONFIG.ballWindowSize, BALL_ANIMATION_CONFIG.ballWindowSize))
  sendCommand(ball, { type: 'flight', cargo })
  await flyBallArc(ball, anchor, to, wa, BALL_ANIMATION_CONFIG.flightMs, ctx)
}

/**
 * 捕获段（hide/relocate 公用）：球窗原地播捕获爆闪 + 宠物渲染侧"被抓"反应 +
 * 宠物窗口以 petCenter 为锚**原地缩小**到 shrinkScale。
 * 只改几何不改可见性——hide 的"随后隐藏"由调用方负责（relocate 则继续飞行）。
 */
export async function capturePetAt(
  win: BrowserWindow,
  ball: BrowserWindow,
  petCenter: Point,
  ctx: FlowContext
): Promise<void> {
  sendCommand(ball, { type: 'capture-burst', holdMs: BALL_ANIMATION_CONFIG.captureMs })
  sendPetReaction(win, 'captured')
  const start = win.getBounds()
  const targetW = Math.max(2, Math.round(start.width * BALL_ANIMATION_CONFIG.shrinkScale))
  const targetH = Math.max(2, Math.round(start.height * BALL_ANIMATION_CONFIG.shrinkScale))
  await animateWindowBounds(
    win,
    BALL_ANIMATION_CONFIG.captureMs,
    easeInOutCubic,
    (e) => boundsAround(petCenter, lerp(start.width, targetW, e), lerp(start.height, targetH, e)),
    ctx
  )
}

/**
 * 释放段（show/relocate 公用）：宠物窗口以 home 中心缩小态出现（不抢焦点）→
 * 球窗释放爆闪 + 宠物渲染侧"落地"反应 → 宠物放大归位到 home（原尺寸矩形）。
 */
export async function releasePetAt(
  win: BrowserWindow,
  ball: BrowserWindow,
  home: Rect,
  ctx: FlowContext
): Promise<void> {
  const homeCenter = centerOf(home)
  const start = boundsAround(
    homeCenter,
    home.width * BALL_ANIMATION_CONFIG.shrinkScale,
    home.height * BALL_ANIMATION_CONFIG.shrinkScale
  )
  win.setBounds(start)
  win.showInactive()
  console.log(`[ball-animation] 释放：宠物窗可见（visible=${win.isVisible()}）`)
  sendCommand(ball, { type: 'release-burst' })
  sendPetReaction(win, 'released')
  await animateWindowBounds(
    win,
    BALL_ANIMATION_CONFIG.releaseMs,
    easeOutCubic,
    (e) => boundsAround(homeCenter, lerp(start.width, home.width, e), lerp(start.height, home.height, e)),
    ctx
  )
}

/** 收尾：球窗淡出（异常/超时路径的收窗由流程外壳的 finally 兜底） */
export async function fadeBallOut(ball: BrowserWindow, ctx: FlowContext): Promise<void> {
  sendCommand(ball, { type: 'fade-out', durationMs: BALL_ANIMATION_CONFIG.fadeMs })
  await sleep(BALL_ANIMATION_CONFIG.fadeMs, ctx)
}
