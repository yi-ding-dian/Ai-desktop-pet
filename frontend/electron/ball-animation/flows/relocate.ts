/** 移动流程（设置向导）：按距离分档——远距完整魔法 / 近距平滑滑行 / 太近直接落位。 */
import type { BrowserWindow } from 'electron'
import { BALL_ANIMATION_CONFIG } from '../config'
import {
  assertLive,
  boundsAround,
  centerOf,
  easeInOutCubic,
  makeArcPath,
  rectStr,
  sleep,
  type FlowContext
} from '../math'
import {
  animateWindowBounds,
  capturePetAt,
  fadeBallOut,
  flyBothArc,
  releasePetAt
} from '../animation'
import { sendCommand } from '../window'
import type { Rect } from '../../window'

/**
 * 移动动画·**远距魔法档**（relocate，"原地凝聚起手"的完整魔法流程，2026-10-16 用户定稿）：
 * ① 球**直接在宠物所在处凝聚显现**（spawn 指令；不走"从托盘锚点飞来"的绕路）→
 * ② 爆闪捕获（宠物原地缩至 shrinkScale + 挣扎反应）→ ③ 球拎着缩小态宠物沿拱线
 * 飞到目标位 → ④ 释放爆闪 + 宠物放大归位 → ⑤ 球淡出收窗。
 *
 * 入位（原位置 → 设置窗底沿）与回位（向导位 → 原位置）共用本流程。
 */
export async function relocateMagicFlow(
  win: BrowserWindow,
  ball: BrowserWindow,
  wa: Rect,
  target: Rect,
  ctx: FlowContext
): Promise<void> {
  const t0 = Date.now()
  const stamp = (msg: string): void => console.log(`[ball-animation] t=${Date.now() - t0}ms ${msg}`)

  // 防御：宠物当前隐藏时（向导流程理论上总在可见时触发；竞态下可能赶上隐藏）——
  // 只静默 setBounds(target)（不播动画、不显示：避免"回位"把用户刚隐藏的宠物弹出）
  if (!win.isVisible()) {
    console.log(`[ball-animation] 移动动画：宠物当前隐藏 → 仅静默改坐标至 ${rectStr(target)}（不播动画、不显示）`)
    win.setBounds(target)
    return
  }

  const from = win.getBounds()
  const petCenter = centerOf(from)
  const toCenter = centerOf(target)
  stamp(`移动动画开始（远距魔法）：宠物 ${rectStr(from)} → ${rectStr(target)}`)

  // ① 球在宠物处原地凝聚显现（球窗定位到宠物中心；动画页从无到有画出光球 + 微脉动）
  ball.setBounds(boundsAround(petCenter, BALL_ANIMATION_CONFIG.ballWindowSize, BALL_ANIMATION_CONFIG.ballWindowSize))
  sendCommand(ball, { type: 'spawn', durationMs: BALL_ANIMATION_CONFIG.relocateSpawnMs })
  await sleep(BALL_ANIMATION_CONFIG.relocateSpawnMs, ctx)
  assertLive(ctx)
  stamp(`球凝聚完成（原地 ${BALL_ANIMATION_CONFIG.relocateSpawnMs}ms）`)

  // ② 捕获爆闪：宠物原地缩小（只改几何，不 hide）
  await capturePetAt(win, ball, petCenter, ctx)
  assertLive(ctx)
  stamp(`捕获完成（宠物缩至 ${BALL_ANIMATION_CONFIG.shrinkScale}×，${rectStr(win.getBounds())}）`)

  // ③ 球拎着缩小态宠物沿拱线飞向目标位（终点 = 目标矩形中心，释放点与目标同中心）
  const petShrunk = win.getBounds()
  // 与 hide/show 同法：飞行期间隐藏宠物窗，只让球载着 cargo 剪影飞
  const wasVisible = win.isVisible()
  win.hide()
  console.log(`[ball-animation] 移动动画：飞行期间宠物窗隐藏（visible=${win.isVisible()}）`)
  try {
    sendCommand(ball, { type: 'flight', cargo: true })
    await flyBothArc(
      ball,
      win,
      petCenter,
      toCenter,
      wa,
      { width: petShrunk.width, height: petShrunk.height },
      BALL_ANIMATION_CONFIG.returnMs,
      ctx
    )
    assertLive(ctx)
    stamp(`到达目标位（fly ${BALL_ANIMATION_CONFIG.returnMs}ms）`)

    // ④ 释放爆闪 + 宠物在目标位放大归位
    await releasePetAt(win, ball, target, ctx)
    assertLive(ctx)
    stamp(`放大归位完成（${rectStr(win.getBounds())}）`)
  } finally {
    // 异常/超时路径兜底：原本可见的宠物必须重新出现（坐标由外壳 catch 落到 target）
    if (wasVisible && !win.isDestroyed() && !win.isVisible()) win.showInactive()
  }

  // ⑤ 球淡出收窗
  await fadeBallOut(ball, ctx)
  stamp('移动动画完成')
}

/**
 * 移动动画·**近距档**：宠物原样沿小弧**平滑滑过去**——无球无爆闪；
 * **太近**则直接落位。纯窗口移动，不依赖球窗/动画页。
 */
export async function relocateGlideFlow(
  win: BrowserWindow,
  wa: Rect,
  target: Rect,
  ctx: FlowContext
): Promise<void> {
  const t0 = Date.now()
  const stamp = (msg: string): void => console.log(`[ball-animation] t=${Date.now() - t0}ms ${msg}`)

  if (!win.isVisible()) {
    console.log(`[ball-animation] 移动动画：宠物当前隐藏 → 仅静默改坐标至 ${rectStr(target)}（不播动画、不显示）`)
    win.setBounds(target)
    return
  }

  const from = win.getBounds()
  const fromCenter = centerOf(from)
  const toCenter = centerOf(target)
  const dist = Math.hypot(toCenter.x - fromCenter.x, toCenter.y - fromCenter.y)

  if (dist < BALL_ANIMATION_CONFIG.relocateNearStepPx) {
    win.setBounds(target)
    stamp(
      `移动动画：距离 ${Math.round(dist)}px < ${BALL_ANIMATION_CONFIG.relocateNearStepPx}px → 直接落位（太近了不用飞）`
    )
    return
  }

  stamp(`移动动画开始（近距平滑移位 ${Math.round(dist)}px）：宠物 ${rectStr(from)} → ${rectStr(target)}`)
  const path = makeArcPath(fromCenter, toCenter, wa)
  await animateWindowBounds(
    win,
    BALL_ANIMATION_CONFIG.relocateGlideMs,
    easeInOutCubic,
    (e) => boundsAround(path(e), from.width, from.height),
    ctx
  )
  assertLive(ctx)
  // 精确落位：曲线数值收口（防浮点累积让落点差 1~2px）
  if (!win.isDestroyed()) win.setBounds(target)
  stamp(`平滑移位完成（${rectStr(target)}）`)
}
