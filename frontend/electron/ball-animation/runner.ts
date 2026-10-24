/** 动画公共外壳：锁 → 就绪等待 → 流程 → 兜底（保证结果语义）。 */
import { screen, type BrowserWindow } from 'electron'
import { BALL_ANIMATION_CONFIG } from './config'
import { isAppQuitting } from '../lifecycle'
import { setWindowMoveLock } from '../window/move-lock'
import { ballState } from './state'
import { centerOf, type FlowContext } from './math'
import {
  currentBallWindow,
  ensureBallWindow,
  resolveTrayAnchorPoint,
  sendCommand,
  waitFxReady
} from './window'
import { hideFlow, showFlow } from './flows/hide-show'
import { relocateGlideFlow, relocateMagicFlow } from './flows/relocate'
import type { Point, Rect } from '../window'

/** 动画方向（对外三流程：隐藏 / 显示 / 移动） */
export type FlowDirection = 'hide' | 'show' | 'relocate'

/** 等待动画锁空闲（relocate 专用；100ms 粒度轮询，超时返回 false） */
export function waitBusyFree(timeoutMs: number): Promise<boolean> {
  if (!ballState.busy) return Promise.resolve(true)
  const t0 = Date.now()
  return new Promise((resolve) => {
    const tick = (): void => {
      if (!ballState.busy) {
        resolve(true)
        return
      }
      if (Date.now() - t0 >= timeoutMs) {
        resolve(false)
        return
      }
      setTimeout(tick, 100)
    }
    setTimeout(tick, 100)
  })
}

/**
 * 动画公共外壳：锁 → 就绪等待 → 流程 → 兜底（保证结果语义）。
 * @param target 仅 relocate 方向使用：异常/降级兜底时直接落到该目标矩形。
 */
export async function runFlow(
  win: BrowserWindow,
  direction: FlowDirection,
  degrade: () => void,
  target?: Rect,
  forceGlide = false
): Promise<void> {
  const label = direction === 'hide' ? '隐藏' : direction === 'show' ? '显示' : '移动'
  if (win.isDestroyed()) return
  // 退出中：不再创建球窗/逐帧动画（会卡住 Electron 退出），直接走降级路径
  if (isAppQuitting()) {
    console.log(`[ball-animation] 应用退出中：${label}直接降级`)
    degrade()
    return
  }
  if (ballState.busy) {
    console.log(`[ball-animation] 动画进行中，忽略本次${label}请求`)
    return
  }
  ballState.busy = true
  // 动画逐帧改宠物窗口尺寸（缩小/放大）：期间锁住拖拽与 moveTo，防止外部移动源把
  // 缩小态的 bounds 快照下来并一路保持，动画结束后宠物停在 ~100×100（只剩兔头）
  setWindowMoveLock(true)
  const ctx: FlowContext = { aborted: false }
  const watchdog = setTimeout(() => {
    ctx.aborted = true
    console.warn(`[ball-animation] ${label}动画超时（>${BALL_ANIMATION_CONFIG.totalTimeoutMs}ms），看门狗中止`)
  }, BALL_ANIMATION_CONFIG.totalTimeoutMs)
  try {
    if (direction === 'relocate') {
      // 移动方向按距离分档（2026-10-16 用户定稿）：
      //   远距（≥ relocateMagicMinPx）：完整魔法，需要球窗与 动画页就绪；不定位托盘锚点
      //     （球不走"从托盘飞来"的绕路，直接在宠物处凝聚）；
      //   近距（< 上限）：平滑移位 / 太近直接落位——纯窗口移动，不建球窗、不等 动画页。
      if (!target) return
      const wa = screen.getPrimaryDisplay().workArea
      const fromC = centerOf(win.getBounds())
      const toC = centerOf(target)
      const dist = Math.hypot(toC.x - fromC.x, toC.y - fromC.y)
      if (dist < BALL_ANIMATION_CONFIG.relocateMagicMinPx || forceGlide) {
        // 近距档 / 强制滑步（教学入位）：平滑移位或直接落位——不建球窗、不等 动画页
        await relocateGlideFlow(win, wa, target, ctx)
      } else {
        const ball = ensureBallWindow()
        const ready = await waitFxReady(BALL_ANIMATION_CONFIG.readyTimeoutMs)
        if (!ready) {
          console.warn(`[ball-animation] 动画页未就绪（>${BALL_ANIMATION_CONFIG.readyTimeoutMs}ms），本次降级为直接${label}`)
          degrade()
          return
        }
        sendCommand(ball, { type: 'reset' })
        ball.moveTop() // 与宠物同为 screen-saver 层：显示前 raise 自保（球要盖在宠物上表现吸进/放出）
        ball.showInactive()
        await relocateMagicFlow(win, ball, wa, target, ctx)
      }
    } else {
      const ball = ensureBallWindow()
      // 动画页就绪等待 与 锚点解析并行 —— 降低"按下到球起飞"的感知延迟；
      // 锚点优先托盘域提供者（Windows = tray.getBounds / 任务栏角落，零延迟）；
      // 没有提供者（Linux）才走抓屏模板匹配；任何失败都返回兜底值，绝不影响动画播放
      const [ready, anchorPoint] = await Promise.all([
        waitFxReady(BALL_ANIMATION_CONFIG.readyTimeoutMs),
        resolveTrayAnchorPoint()
      ])
      if (!ready) {
        console.warn(`[ball-animation] 动画页未就绪（>${BALL_ANIMATION_CONFIG.readyTimeoutMs}ms），本次降级为直接${label}`)
        degrade()
        return
      }
      sendCommand(ball, { type: 'reset' })
      ball.moveTop() // 与宠物同为 screen-saver 层：显示前 raise 自保（球要盖在宠物上表现吸进/放出）
      ball.showInactive()
      const wa = screen.getPrimaryDisplay().workArea
      const anchor: Point = anchorPoint
      if (direction === 'hide') await hideFlow(win, ball, wa, anchor, ctx)
      else await showFlow(win, ball, wa, anchor, ctx)
    }
  } catch (err) {
    console.error(`[ball-animation] ${label}动画异常，兜底直接${label}：`, err)
    if (!win.isDestroyed()) {
      if (direction === 'hide') {
        win.hide()
      } else if (direction === 'show') {
        // 显示方向异常兜底：一定可见 + 归位（stash 有则回原位）
        if (ballState.stashedBounds) win.setBounds(ballState.stashedBounds)
        if (!win.isVisible()) win.showInactive()
      } else if (target) {
        // 移动方向异常兜底：一定落在目标矩形（可见性保持原状——宠物若已被隐藏不强行显示）
        win.setBounds(target)
      }
    }
  } finally {
    clearTimeout(watchdog)
    if (!win.isDestroyed()) {
      // 结果语义兜底（幂等）：隐藏方向一定不可见；显示方向一定可见
      // （移动方向不改可见性：由 relocate 流程自己保证"可见进 → 可见出"）
      if (direction === 'hide' && win.isVisible()) win.hide()
      if (direction === 'show' && !win.isVisible()) win.showInactive()
    }
    // 球窗收窗（异常/超时路径也要收，防残留一个飘着的球）
    const ball = currentBallWindow()
    if (ball && !ball.isDestroyed() && ball.isVisible()) ball.hide()
    // 解锁必须在 finally：异常/超时/中止路径都要恢复用户拖拽与行为移动
    setWindowMoveLock(false)
    ballState.busy = false
  }
}
