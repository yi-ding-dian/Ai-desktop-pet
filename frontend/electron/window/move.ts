/**
 * 窗口缓动移动与几何读取（moveTo / getGeometry 的共享实现，三平台复用）。
 *
 * 为什么在主进程做动画：渲染进程只发一条"移动到 (x, y)，时长 N ms"的指令（单次 IPC），
 * 缓动帧动画由主进程逐帧 setBounds 完成——避免高频 IPC（60fps 的坐标流），
 * 也让"移动被取消"（用户抓取/新对话）在窗口层即时生效。
 *
 * 实现细节：
 * - 主进程没有 requestAnimationFrame，用 setInterval(~16ms) 近似 60fps；
 * - easeInOutQuad 缓动（起步/收尾都柔和，符合"小宠物迈步"的观感）；
 * - 目标点 clamp 到所在显示器工作区（防走出屏幕；被 clamp 后实际落点以 resolve 值返回）。
 */
import { screen, type BrowserWindow } from 'electron'
import type { MoveResult, Point, Size, WindowGeometry } from './index'

/** 逐帧间隔（ms）：≈60fps */
const FRAME_INTERVAL_MS = 16

/** 缓动曲线：easeInOutQuad（t ∈ [0,1]） */
function easeInOutQuad(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - 2 * (1 - t) * (1 - t)
}

/** 读取窗口几何快照（位置/尺寸/所在显示器工作区） */
export function readGeometry(win: BrowserWindow): WindowGeometry {
  const b = win.getBounds()
  return {
    pos: { x: b.x, y: b.y },
    size: { width: b.width, height: b.height },
    workArea: screen.getDisplayMatching(b).workArea
  }
}

/** 把目标左上角坐标 clamp 到目标位置所在显示器的工作区内 */
export function clampToWorkArea(target: Point, size: Size): Point {
  const wa = screen.getDisplayMatching({
    x: Math.round(target.x),
    y: Math.round(target.y),
    width: size.width,
    height: size.height
  }).workArea
  return {
    x: Math.round(Math.min(Math.max(target.x, wa.x), wa.x + wa.width - size.width)),
    y: Math.round(Math.min(Math.max(target.y, wa.y), wa.y + wa.height - size.height))
  }
}

/** 缓动移动句柄（挂到平台 capability 上） */
export interface EasedMover {
  moveTo(x: number, y: number, durationMs: number): Promise<MoveResult>
  cancelMove(): void
}

/**
 * 创建窗口缓动移动器。
 * 语义：同一时刻至多一个进行中的移动；新 moveTo 会抢占旧移动（旧移动以 completed:false 结束）。
 */
export function createEasedMover(win: BrowserWindow): EasedMover {
  let timer: NodeJS.Timeout | null = null
  let settle: ((result: MoveResult) => void) | null = null

  const stopTimer = (): void => {
    if (timer !== null) {
      clearInterval(timer)
      timer = null
    }
  }

  /** 结束当前移动：completed=true 时窗口已在目标点（或已到最后帧） */
  const finish = (completed: boolean): void => {
    const resolve = settle
    settle = null
    stopTimer()
    if (!resolve) return
    const b = win.getBounds()
    resolve({ x: b.x, y: b.y, completed })
  }

  const moveTo = (x: number, y: number, durationMs: number): Promise<MoveResult> =>
    new Promise((resolve) => {
      // 抢占旧的进行中移动（旧调用方拿到 completed:false，自行按"被打断"处理）
      if (settle) finish(false)
      if (win.isDestroyed()) {
        resolve({ x: 0, y: 0, completed: false })
        return
      }

      const start = win.getBounds()
      const size: Size = { width: start.width, height: start.height }
      const target = clampToWorkArea({ x, y }, size)

      if (durationMs <= 0) {
        win.setBounds({ x: target.x, y: target.y, width: size.width, height: size.height })
        resolve({ x: target.x, y: target.y, completed: true })
        return
      }

      settle = resolve
      const t0 = Date.now()
      timer = setInterval(() => {
        if (win.isDestroyed()) {
          finish(false)
          return
        }
        const p = Math.min(1, (Date.now() - t0) / durationMs)
        const e = easeInOutQuad(p)
        win.setBounds({
          x: Math.round(start.x + (target.x - start.x) * e),
          y: Math.round(start.y + (target.y - start.y) * e),
          width: size.width,
          height: size.height
        })
        if (p >= 1) {
          console.log(`[window/move] moveTo 完成 → ${target.x},${target.y}（${durationMs}ms）`)
          finish(true)
        }
      }, FRAME_INTERVAL_MS)
    })

  const cancelMove = (): void => {
    if (settle) {
      console.log('[window/move] moveTo 被取消（未达目标）')
      finish(false)
    }
  }

  return { moveTo, cancelMove }
}
