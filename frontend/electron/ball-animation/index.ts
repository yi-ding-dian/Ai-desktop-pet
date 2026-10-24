/**
 * 魔法球动画域（fx）入口：对外 API + 移动流程的前置检查。
 *
 * 目录分工：
 * - ``window.ts``   球窗（懒创建 / 就绪握手 / 指令下发 / 销毁 / 预热）；
 * - ``math.ts``     缓动、拱线与几何（纯函数）；
 * - ``animation.ts``动画原子（窗口缓动、飞行、捕获/释放/淡出）；
 * - ``state.ts``    动画锁与"隐藏前的家"；
 * - ``runner.ts``   公共外壳（锁 → 就绪等待 → 流程 → 兜底）；
 * - ``flows/``      具体流程：hide-show / launch / farewell / relocate / lifecycle。
 *
 * 设计背景见 docs/reports/frontend/2026-10-15-ball-animation.md。
 */
import type { BrowserWindow } from 'electron'
import { BALL_ANIMATION_CONFIG } from './config'
import { isAppQuitting } from '../lifecycle'
import { rectStr } from './math'
import { runFlow, waitBusyFree } from './runner'
import { ballState } from './state'
import type { Rect } from '../window'

export { setTrayAnchorProvider, destroyBallAnimation, prewarmBallAnimation } from './window'
export { runLaunchAnimation, runFarewellAnimation } from './flows/lifecycle'

/** 隐藏流程：托盘"隐藏宠物"、Alt+F4 关窗拦截、单击切换等路径统一调用 */
export function runHideAnimation(win: BrowserWindow): Promise<void> {
  if (!BALL_ANIMATION_CONFIG.ENABLED) {
    win.hide()
    return Promise.resolve()
  }
  return runFlow(win, 'hide', () => win.hide())
}

/** 显示流程：托盘菜单"显示宠物"、托盘单击等路径统一调用 */
export function runShowAnimation(win: BrowserWindow): Promise<void> {
  if (!BALL_ANIMATION_CONFIG.ENABLED) {
    win.showInactive()
    return Promise.resolve()
  }
  return runFlow(win, 'show', () => {
    // 降级：瞬时显示（并发进行归位——stash 存在时窗口当前在缩小态）
    if (ballState.stashedBounds && !win.isDestroyed()) win.setBounds(ballState.stashedBounds)
    win.showInactive()
  })
}

/**
 * 移动流程（设置向导 §7.6.6）：把宠物从当前位挪到 target——**按距离分档**（2026-10-16 定稿）：
 *   ≥ relocateMagicMinPx：完整魔法（球**在宠物处原地凝聚** → 捕获爆闪 → 携宠沿拱线飞行
 *     → 释放爆闪；见 flows/relocate.ts）；
 *   < 上限：近距平滑移位 / 太近直接落位。
 *
 * 与隐藏/显示不同：relocate 不采用"忙则忽略"——在途动画优先收尾（上限
 * BALL_ANIMATION_CONFIG.relocateBusyWaitMs），超时才放弃本次。
 * 结果语义：宠物窗口在 target；可见性保持调用前状态。
 *
 * @param opts.forceGlide 强制走"近距平滑移位"档（跳过魔法/球窗流程）——教学入位专用。
 */
export async function runRelocateAnimation(
  win: BrowserWindow,
  target: Rect,
  opts?: { forceGlide?: boolean }
): Promise<void> {
  if (!win || win.isDestroyed()) return
  if (!BALL_ANIMATION_CONFIG.ENABLED) {
    win.setBounds(target)
    return
  }
  // 退出中：只瞬时落位，不建球窗（设置窗关闭回位可能发生在 will-quit 期间）
  if (isAppQuitting()) {
    console.log('[ball-animation] 应用退出中：跳过回位动画，直接落位')
    win.setBounds(target)
    return
  }
  const free = await waitBusyFree(BALL_ANIMATION_CONFIG.relocateBusyWaitMs)
  if (!free) {
    console.warn(
      `[ball-animation] 在途动画超过 ${BALL_ANIMATION_CONFIG.relocateBusyWaitMs}ms 未收尾，放弃本次移动（目标 ${rectStr(target)}）`
    )
    return
  }
  if (win.isDestroyed()) return
  // 隐藏态早退（在锁空闲之后判断：此刻无在途动画、窗口静止）——只搬家不显示、不播动画，
  // 也避免白闪一个空球窗；"就绪等待期间被隐藏"的竞态由 relocate 流程内防御分支兜底
  if (!win.isVisible()) {
    console.log(`[ball-animation] 移动动画：宠物当前隐藏 → 仅静默改坐标至 ${rectStr(target)}（不播动画、不显示）`)
    win.setBounds(target)
    return
  }
  return runFlow(
    win,
    'relocate',
    () => {
      // 降级：瞬时落位（动画页未就绪/超时——不播动画，位置语义照旧）
      win.setBounds(target)
    },
    target,
    opts?.forceGlide
  )
}
