/** 退出告别：球原地凝聚 → 捕获 → 载宠沿弧线向上飞出屏幕。 */
import type { BrowserWindow } from 'electron'
import { BALL_ANIMATION_CONFIG } from '../config'
import {
  assertLive,
  boundsAround,
  easeInCubic,
  ptStr,
  sleep,
  type FlowContext
} from '../math'
import { capturePetAt, flyBallArc } from '../animation'
import { sendCommand } from '../window'
import type { Point, Rect } from '../../window'

/**
 * 退出告别流程（仅托盘"退出"）：① 球在宠物处原地凝聚 → ② 捕获爆闪（宠物缩小 + 挣扎）→
 * ③ 宠物窗隐藏，球载着剪影**沿弧线向上飞出屏幕**（朝更近的一侧边缘拱起，easeIn 加速离场）→
 * ④ 收窗（调用方随后真正退出）。"再见啦~"由 runFarewellAnimation 在捕获前下发。
 */
export async function farewellFlow(
  win: BrowserWindow,
  ball: BrowserWindow,
  wa: Rect,
  petCenter: Point,
  ctx: FlowContext
): Promise<void> {
  const t0 = Date.now()
  const stamp = (msg: string): void => console.log(`[ball-animation] t=${Date.now() - t0}ms ${msg}`)

  // ① 球在宠物处原地凝聚
  ball.setBounds(
    boundsAround(petCenter, BALL_ANIMATION_CONFIG.ballWindowSize, BALL_ANIMATION_CONFIG.ballWindowSize)
  )
  sendCommand(ball, { type: 'spawn', durationMs: BALL_ANIMATION_CONFIG.relocateSpawnMs })
  await sleep(BALL_ANIMATION_CONFIG.relocateSpawnMs, ctx)
  assertLive(ctx)
  stamp(`球凝聚完成（原地 ${BALL_ANIMATION_CONFIG.relocateSpawnMs}ms）`)

  // ② 捕获爆闪：宠物原地缩小（只改几何，不 hide）
  await capturePetAt(win, ball, petCenter, ctx)
  assertLive(ctx)
  stamp(`捕获完成（宠物缩至 ${BALL_ANIMATION_CONFIG.shrinkScale}×）`)

  // ③ 宠物窗隐藏，球载宠沿弧线向上飞出屏幕：朝更近的一侧边缘拱起，弧线更明显
  if (!win.isDestroyed()) win.hide()
  const dir = petCenter.x <= wa.x + wa.width / 2 ? 1 : -1
  const driftX = petCenter.x + dir * BALL_ANIMATION_CONFIG.farewellArcDriftPx
  const target: Point = {
    // 水平位置夹在工作区内（只做弧线拱起，不横穿出屏）
    x: Math.min(wa.x + wa.width - 40, Math.max(wa.x + 40, driftX)),
    // 球窗中心在屏幕上方外一个球径处：窗口整体出屏，收尾干净
    y: wa.y - BALL_ANIMATION_CONFIG.ballWindowSize
  }
  sendCommand(ball, { type: 'flight', cargo: true })
  await flyBallArc(
    ball,
    petCenter,
    target,
    wa,
    BALL_ANIMATION_CONFIG.farewellFlyMs,
    ctx,
    easeInCubic
  )
  assertLive(ctx)
  stamp(`飞出屏幕（fly ${BALL_ANIMATION_CONFIG.farewellFlyMs}ms，目标 ${ptStr(target)}）`)
}
