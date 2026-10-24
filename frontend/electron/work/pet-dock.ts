/**
 * 宠物 ↔ 工作窗的落位：进入工作模式时贴到窗口左侧（与教学讲台同一套几何），
 * 关闭/最小化/折叠时滑步回原位。只负责位置，不碰窗口生命周期。
 */
import { screen, type BrowserWindow } from 'electron'
import { petWindowSize, type Point, type Rect, type Size } from '../window'
import { getPetScale } from '../pet-scale'
import { podiumPoint } from '../teaching/geometry'
import { runRelocateAnimation } from '../ball-animation'

export type TeachingMode = 'normal' | 'teaching'

export class PetDock {
  private placed = false
  /** 进入工作模式前的宠物原位（只记坐标，尺寸用 petWindowSize） */
  private homeRect: Rect | null = null

  constructor(
    private readonly getPet: () => BrowserWindow | null,
    private readonly getTeachingMode: () => TeachingMode
  ) {}

  /** 当前缩放档位下的宠物窗尺寸（工作模式中禁止改档位，值稳定） */
  size(): Size {
    return petWindowSize(getPetScale())
  }

  /**
   * 工作窗左侧的宠物落点（与教学讲台同几何）。
   * 工作窗被拖到屏幕最左时，讲台点会落到屏幕外——夹回工作区左缘，让兔子
   * 贴着窗口左侧、部分叠在窗口上，而不是整窗消失。
   */
  attachPoint(rect: Rect): Point {
    const point = podiumPoint(rect, getPetScale())
    const wa = screen.getDisplayMatching(rect).workArea
    return { x: Math.max(wa.x + 8, point.x), y: point.y }
  }

  /**
   * 宠物依附到工作窗左侧（与教学模式讲台同一套几何：图像右缘贴窗左下角、脚底与窗底平齐）。
   *
   * 只有首次依附时记原位（关闭/最小化回位目标）；之后再次调用（用户在工作模式中把宠物
   * 拖走后再点菜单「工作模式」/恢复窗口）会重新吸附到左侧，但不覆盖原位。
   * 已经贴在工作窗左侧时直接跳过，避免重复启动滑步动画。
   */
  place(rect: Rect): void {
    // 教学模式优先：两边同时在场时不去抢讲台位
    if (this.getTeachingMode() !== 'normal') return
    const pet = this.getPet()
    if (pet === null || pet.isDestroyed()) return
    const bounds = pet.getBounds()
    const size = this.size()
    if (!this.placed) {
      this.homeRect = {
        x: bounds.x,
        y: bounds.y,
        width: size.width,
        height: size.height
      }
      this.placed = true
    }
    const point = this.attachPoint(rect)
    if (bounds.x === point.x && bounds.y === point.y) return
    console.log(
      `[work] 宠物依附工作窗左侧：${bounds.x},${bounds.y} → ${point.x},${point.y}（原位 ${this.homeRect?.x ?? bounds.x},${this.homeRect?.y ?? bounds.y}）`
    )
    void runRelocateAnimation(
      pet,
      { x: point.x, y: point.y, width: size.width, height: size.height },
      { forceGlide: true }
    )
  }

  /** 把宠物放到指定点（最大化时用：贴屏幕左缘、竖向居中） */
  placeAt(point: Point): void {
    if (this.getTeachingMode() !== 'normal') return
    const pet = this.getPet()
    if (pet === null || pet.isDestroyed()) return
    const size = this.size()
    if (!this.placed) {
      const bounds = pet.getBounds()
      this.homeRect = { x: bounds.x, y: bounds.y, width: size.width, height: size.height }
      this.placed = true
    }
    void runRelocateAnimation(
      pet,
      { x: point.x, y: point.y, width: size.width, height: size.height },
      { forceGlide: true }
    )
  }

  /** 关闭/最小化工作窗：宠物滑步回进入工作模式前的位置（教学模式下让教学域自己管） */
  returnHome(): void {
    if (!this.placed) return
    this.placed = false
    const home = this.homeRect
    this.homeRect = null
    const pet = this.getPet()
    if (pet === null || pet.isDestroyed() || home === null) return
    if (this.getTeachingMode() !== 'normal') return
    console.log(`[work] 关闭工作窗，宠物回位 → ${home.x},${home.y}`)
    void runRelocateAnimation(pet, home, { forceGlide: true })
  }

  /**
   * 工作窗被拖动/缩放：宠物同帧跟到新的左缘（与教学 followPodium 同语义）。
   * 尺寸用设计常量，避免 fractional DPI 下把舍入宽高回喂。
   */
  follow(rect: Rect): void {
    if (!this.placed) return
    if (this.getTeachingMode() !== 'normal') return
    const pet = this.getPet()
    if (pet === null || pet.isDestroyed() || !pet.isVisible()) return
    const point = this.attachPoint(rect)
    const size = this.size()
    pet.setBounds({ x: point.x, y: point.y, width: size.width, height: size.height })
  }

  /** 清除依附状态（应用退出/窗口销毁） */
  reset(): void {
    this.placed = false
    this.homeRect = null
  }
}
