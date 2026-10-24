/** 启动演出：球载着宠物从屏幕上方外俯冲入位，落地后说"我来了~"。 */
import type { BrowserWindow } from 'electron'
import { BALL_ANIMATION_CONFIG } from '../config'
import {
  assertLive,
  centerOf,
  ptStr,
  rectStr,
  sleep,
  type FlowContext
} from '../math'
import { fadeBallOut, flyBallFromAnchor, releasePetAt } from '../animation'
import { sendPetSay } from '../window'
import type { Point, Rect } from '../../window'

/**
 * 启动流程（应用冷启动的"出场"）：① 球载着宠物剪影从**屏幕上方外**沿弧线俯冲到落点中心 →
 * ② 宠物窗在落点以缩小态出现 → 爆闪释放 + 放大归位（落地 Q 弹）→ ③ 球淡出 →
 * ④ 停顿 greetingDelayMs 后说"我来了~"。
 * 与 showFlow 的唯一差别：起点是屏幕上的天空（而非托盘锚点），且开场带一句问候。
 */
export async function launchFlow(
  win: BrowserWindow,
  ball: BrowserWindow,
  wa: Rect,
  home: Rect,
  ctx: FlowContext
): Promise<void> {
  const t0 = Date.now()
  const stamp = (msg: string): void => console.log(`[ball-animation] t=${Date.now() - t0}ms ${msg}`)

  const homeCenter = centerOf(home)
  // 屏外起点：球窗中心在工作区上方外一个球径处（窗口整体不可见）；水平左偏形成俯冲弧线
  const anchor: Point = {
    x: homeCenter.x + BALL_ANIMATION_CONFIG.launchStartDxPx,
    y: wa.y - BALL_ANIMATION_CONFIG.ballWindowSize
  }
  stamp(`启动动画开始：落点 ${rectStr(home)}，屏外起点 ${ptStr(anchor)}`)

  // ① 球（载宠物剪影）沿拱线飞入落点
  await flyBallFromAnchor(ball, anchor, homeCenter, wa, true, ctx)
  assertLive(ctx)
  stamp(`球飞抵落点（flight ${BALL_ANIMATION_CONFIG.flightMs}ms）`)

  // ② 释放：宠物窗在落点以缩小态出现 → 爆闪 + 放大归位
  await releasePetAt(win, ball, home, ctx)
  assertLive(ctx)
  if (!win.isDestroyed()) win.setBounds(home) // 精确归位（与 showFlow 同款收口）
  stamp(`放大归位完成（${rectStr(win.getBounds())}）`)

  // ③ 球淡出收窗
  await fadeBallOut(ball, ctx)

  // ④ 站定后开口问候（本地文案；气泡展示失败也不影响启动）
  await sleep(BALL_ANIMATION_CONFIG.greetingDelayMs, ctx)
  if (!win.isDestroyed()) {
    sendPetSay(win, {
      text: BALL_ANIMATION_CONFIG.greetingText,
      ttlMs: BALL_ANIMATION_CONFIG.greetingTtlMs,
      kind: 'greeting'
    })
    stamp('启动问候已下发')
  }
}
