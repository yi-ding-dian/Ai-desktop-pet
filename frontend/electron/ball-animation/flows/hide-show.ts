/** 隐藏 / 显示流程：球在托盘与宠物之间往返，载着缩小态的宠物"吸进/放出"。 */
import type { BrowserWindow } from 'electron'
import { BALL_ANIMATION_CONFIG } from '../config'
import { ballState } from '../state'
import {
  assertLive,
  atDesignSize,
  centerOf,
  ptStr,
  rectStr,
  type FlowContext
} from '../math'
import {
  capturePetAt,
  fadeBallOut,
  flyBallFromAnchor,
  flyBothArc,
  releasePetAt
} from '../animation'
import { sendCommand } from '../window'
import type { Point, Rect } from '../../window'

/**
 * 隐藏动画：① 球（空）沿拱线从托盘飞到宠物中心 → ② 抵达爆散（捕获：宠物原地缩小 +
 * 挣扎反应，球窗播爆散）→ ③ 球与缩小态的宠物沿同一条拱线**一起**飞回托盘 →
 * ④ 到达后宠物 hide，球淡出收窗。
 */
export async function hideFlow(
  win: BrowserWindow,
  ball: BrowserWindow,
  wa: Rect,
  anchor: Point,
  ctx: FlowContext
): Promise<void> {
  const t0 = Date.now()
  const stamp = (msg: string): void => console.log(`[ball-animation] t=${Date.now() - t0}ms ${msg}`)

  const stash = atDesignSize(win.getBounds())
  ballState.stashedBounds = stash
  const petCenter = centerOf(stash)
  stamp(`隐藏动画开始：宠物 ${rectStr(stash)}，锚点 ${ptStr(anchor)}`)

  // ① 球（空载）沿拱线从托盘飞到宠物中心
  await flyBallFromAnchor(ball, anchor, petCenter, wa, false, ctx)
  assertLive(ctx)
  stamp(`球到达宠物（flight ${BALL_ANIMATION_CONFIG.flightMs}ms）`)

  // ② 抵达爆散（捕获）：球窗播爆散粒子/光晕/扩散环 + 渲染侧挣扎反应 + 宠物窗口原地缩小
  await capturePetAt(win, ball, petCenter, ctx)
  assertLive(ctx)
  stamp(`捕获完成（宠物缩至 ${BALL_ANIMATION_CONFIG.shrinkScale}×，${rectStr(win.getBounds())}）`)

  // ③ 球拎着缩小态的宠物沿同一条拱线一起飞回托盘（球窗盖在宠物上=吸进球里）
  const petShrunk = win.getBounds()
  // 回程只让球载着剪影飞：宠物窗必须隐藏——否则缩小的宠物窗会在球旁露出兔头/身体残片
  win.hide()
  sendCommand(ball, { type: 'flight', cargo: true })
  await flyBothArc(
    ball,
    win,
    petCenter,
    anchor,
    wa,
    { width: petShrunk.width, height: petShrunk.height },
    BALL_ANIMATION_CONFIG.returnMs,
    ctx
  )
  assertLive(ctx)
  stamp(`到达托盘锚点（return ${BALL_ANIMATION_CONFIG.returnMs}ms）`)

  // ④ 宠物 hide（此刻它已在托盘处的缩小态）；球淡出收窗
  win.hide()
  await fadeBallOut(ball, ctx)
  stamp('隐藏动画完成')
}

/**
 * 显示动画（隐藏的反向）：① 球（载着宠物剪影）从托盘飞到原位中心 →
 * ② 到达后宠物窗口在原位以缩小态出现 → 爆闪释放 + 放大归位 + 渲染侧落地 Q 弹 →
 * ③ 球淡出收窗。
 */
export async function showFlow(
  win: BrowserWindow,
  ball: BrowserWindow,
  wa: Rect,
  anchor: Point,
  ctx: FlowContext
): Promise<void> {
  const t0 = Date.now()
  const stamp = (msg: string): void => console.log(`[ball-animation] t=${Date.now() - t0}ms ${msg}`)

  // 原位：优先用隐藏时记录的家；缺失（异常路径）时退回当前 bounds
  const home = ballState.stashedBounds ?? atDesignSize(win.getBounds())
  const homeCenter = centerOf(home)
  stamp(`显示动画开始：原位 ${rectStr(home)}，锚点 ${ptStr(anchor)}`)

  // ① 球（载宠物剪影）沿拱线从托盘飞到原位中心（飞行期间宠物窗口保持隐藏，由球"携带"）
  await flyBallFromAnchor(ball, anchor, homeCenter, wa, true, ctx)
  assertLive(ctx)
  stamp(`球到达原位（flight ${BALL_ANIMATION_CONFIG.flightMs}ms）`)

  // ② 释放：宠物窗口以原位缩小态出现（不抢焦点）→ 爆闪 + 落地 Q 弹 + 放大归位
  await releasePetAt(win, ball, home, ctx)
  assertLive(ctx)
  // 精确归位：动画帧数值收口；同时兜底任何并发移动源（移动锁已挡拖拽/moveTo，
  // 这里再保证一次"显示结束一定是完整 400×400"，避免留下缩小态只剩兔头）
  if (!win.isDestroyed()) win.setBounds(home)
  ballState.stashedBounds = null
  stamp(`放大归位完成（${rectStr(win.getBounds())}）`)

  // ③ 球淡出收窗
  await fadeBallOut(ball, ctx)
  stamp('显示动画完成')
}
