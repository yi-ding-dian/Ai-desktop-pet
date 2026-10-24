/** 生命周期演出（启动 / 退出）与它们的降级路径。 */
import { screen, type BrowserWindow } from 'electron'
import { BALL_ANIMATION_CONFIG } from '../config'
import { isAppQuitting } from '../../lifecycle'
import { setWindowMoveLock } from '../../window/move-lock'
import { ballState } from '../state'
import { atDesignSize, centerOf, sleep, type FlowContext } from '../math'
import {
  currentBallWindow,
  ensureBallWindow,
  sendCommand,
  sendPetSay,
  waitFxReady
} from '../window'
import { waitBusyFree } from '../runner'
import { launchFlow } from './launch'
import { farewellFlow } from './farewell'

/** 降级启动：直接显示 + 停顿后问候（动画页未就绪/异常/总开关关闭时使用） */
async function showAndGreet(win: BrowserWindow): Promise<void> {
  if (win.isDestroyed()) return
  win.showInactive()
  const ctx: FlowContext = { aborted: false }
  await sleep(BALL_ANIMATION_CONFIG.greetingDelayMs, ctx)
  if (!win.isDestroyed()) {
    sendPetSay(win, {
      text: BALL_ANIMATION_CONFIG.greetingText,
      ttlMs: BALL_ANIMATION_CONFIG.greetingTtlMs,
      kind: 'greeting'
    })
  }
}

/**
 * 启动流程（应用冷启动；main 在宠物窗 ready-to-show 时调用）：
 * 球从屏幕上方外沿弧线俯冲下来 → 落地释放 → 淡出 → 说"我来了~"。
 * 兜底语义与 runFlow 一致：动画页未就绪/异常/超时一律直接显示（问候照常）。
 */
export async function runLaunchAnimation(win: BrowserWindow): Promise<void> {
  if (!win || win.isDestroyed()) return
  if (!BALL_ANIMATION_CONFIG.ENABLED) {
    void showAndGreet(win)
    return
  }
  if (ballState.busy) {
    // 理论上不会发生（启动时没有其它动画）；防御性地直接显示，避免宠物看不见
    console.warn('[ball-animation] 启动动画：已有动画进行中，直接显示')
    void showAndGreet(win)
    return
  }
  ballState.busy = true
  setWindowMoveLock(true)
  const ctx: FlowContext = { aborted: false }
  const watchdog = setTimeout(() => {
    ctx.aborted = true
    console.warn(`[ball-animation] 启动动画超时（>${BALL_ANIMATION_CONFIG.totalTimeoutMs}ms），看门狗中止`)
  }, BALL_ANIMATION_CONFIG.totalTimeoutMs)
  try {
    const home = atDesignSize(win.getBounds())
    const ball = ensureBallWindow()
    // 启动专用短超时：宁可放弃飞入直接显示，也不让冷启动黑屏等太久
    const ready = await waitFxReady(BALL_ANIMATION_CONFIG.launchReadyTimeoutMs)
    if (!ready) {
      console.warn(
        `[ball-animation] 动画页未就绪（>${BALL_ANIMATION_CONFIG.launchReadyTimeoutMs}ms），本次启动降级为直接显示`
      )
      await showAndGreet(win)
      return
    }
    sendCommand(ball, { type: 'reset' })
    ball.moveTop() // 与宠物同为 screen-saver 层：显示前 raise 自保
    ball.showInactive()
    const wa = screen.getDisplayMatching(home).workArea
    await launchFlow(win, ball, wa, home, ctx)
  } catch (err) {
    console.error('[ball-animation] 启动动画异常，兜底直接显示：', err)
    await showAndGreet(win)
  } finally {
    clearTimeout(watchdog)
    if (!win.isDestroyed() && !win.isVisible()) win.showInactive()
    const ball = currentBallWindow()
    if (ball && !ball.isDestroyed() && ball.isVisible()) ball.hide()
    setWindowMoveLock(false)
    ballState.busy = false
  }
}

/**
 * 退出告别（仅托盘"退出"显式调用；**不**挂在 before-quit 上——系统关机等路径保持即时退出）：
 * 说"再见啦~" → 球原地凝聚 → 捕获 → 球载宠沿弧线向上飞出屏幕。
 *
 * 结果语义：返回时宠物窗一定已隐藏（动画页未就绪/异常/超时同样先 hide 再返回），
 * 调用方随后 awaited 后端清理并 app.quit()。宠物本来就隐藏（在托盘里）时不播，直接返回。
 * 在途动画（如正在显示/隐藏）先等其收尾（上限 farewellBusyWaitMs），超时则跳过告别。
 */
export async function runFarewellAnimation(win: BrowserWindow): Promise<void> {
  if (!win || win.isDestroyed()) return
  if (isAppQuitting()) {
    win.hide()
    return
  }
  if (!BALL_ANIMATION_CONFIG.ENABLED) return
  if (!win.isVisible()) {
    console.log('[ball-animation] 退出告别：宠物当前隐藏，跳过动画')
    return
  }
  const free = await waitBusyFree(BALL_ANIMATION_CONFIG.farewellBusyWaitMs)
  if (!free) {
    console.warn(
      `[ball-animation] 在途动画超过 ${BALL_ANIMATION_CONFIG.farewellBusyWaitMs}ms 未收尾，跳过退出告别`
    )
    return
  }
  if (win.isDestroyed() || !win.isVisible()) return

  // ① 先说再见（渲染侧走说话气泡）；球窗创建/就绪与"把话说完"并行，压低总时长
  sendPetSay(win, {
    text: BALL_ANIMATION_CONFIG.farewellText,
    ttlMs: BALL_ANIMATION_CONFIG.farewellTtlMs,
    kind: 'farewell'
  })

  ballState.busy = true
  setWindowMoveLock(true)
  const ctx: FlowContext = { aborted: false }
  const watchdog = setTimeout(() => {
    ctx.aborted = true
    console.warn(`[ball-animation] 退出告别超时（>${BALL_ANIMATION_CONFIG.totalTimeoutMs}ms），看门狗中止`)
  }, BALL_ANIMATION_CONFIG.totalTimeoutMs)
  try {
    const home = atDesignSize(win.getBounds())
    const wa = screen.getDisplayMatching(home).workArea
    const ball = ensureBallWindow()
    const [ready] = await Promise.all([
      waitFxReady(BALL_ANIMATION_CONFIG.readyTimeoutMs),
      sleep(BALL_ANIMATION_CONFIG.farewellSayMs, ctx)
    ])
    if (!ready) {
      console.warn(
        `[ball-animation] 动画页未就绪（>${BALL_ANIMATION_CONFIG.readyTimeoutMs}ms），本次退出降级为直接隐藏`
      )
      if (!win.isDestroyed()) win.hide()
      return
    }
    sendCommand(ball, { type: 'reset' })
    ball.moveTop()
    ball.showInactive()
    await farewellFlow(win, ball, wa, centerOf(home), ctx)
  } catch (err) {
    console.error('[ball-animation] 退出告别异常，兜底直接隐藏：', err)
    if (!win.isDestroyed()) win.hide()
  } finally {
    clearTimeout(watchdog)
    if (!win.isDestroyed() && win.isVisible()) win.hide()
    const ball = currentBallWindow()
    if (ball && !ball.isDestroyed() && ball.isVisible()) ball.hide()
    setWindowMoveLock(false)
    ballState.busy = false
  }
}
