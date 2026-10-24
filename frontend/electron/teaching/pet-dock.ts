/**
 * 宠物 ↔ 黑板讲台：跟随黑板左下角、滑步就位、下课回位。
 * 只负责位置与原位记忆，不碰黑板窗口生命周期。
 */
import type { BrowserWindow } from 'electron'
import { runRelocateAnimation } from '../ball-animation'
import { petWindowSize, type Rect, type Size } from '../window'
import { getPetScale } from '../pet-scale'
import { podiumPetSize, podiumPoint } from './geometry'

export class PodiumDock {
  /**
   * 进入教学前宠物原位（null = 本次会话没有可回的原位）。
   * 只记坐标，尺寸用设计常量——fractional DPI 下 getBounds 的宽高是舍入值，
   * 回喂 relocate 会让宠物窗每次开合长大 1px（同 window/index.ts 的约定）。
   */
  private homeRect: Rect | null = null

  constructor(private readonly getPet: () => BrowserWindow | null) {}

  /** 当前缩放档位下的宠物窗尺寸 */
  size(): Size {
    return petWindowSize(getPetScale())
  }

  /** 开课时记录宠物原位（退出时回位） */
  recordHome(): void {
    const pet = this.getPet()
    if (!pet || pet.isDestroyed()) return
    const bounds = pet.getBounds()
    const size = this.size()
    this.homeRect = { x: bounds.x, y: bounds.y, width: size.width, height: size.height }
  }

  /** 讲台位跟随：黑板左下角变了（拖边/移位）→ 宠物同帧 setBounds 跟手（尺寸取当前档位） */
  follow(boardRect: Rect): void {
    const pet = this.getPet()
    if (!pet || pet.isDestroyed() || !pet.isVisible()) return
    const point = podiumPoint(boardRect, getPetScale())
    // 尺寸取当前缩放档位：拖动高频触发，回喂 getBounds 的舍入宽高会让宠物窗每次 +1px
    const size = this.size()
    pet.setBounds({ x: point.x, y: point.y, width: size.width, height: size.height })
  }

  /**
   * 兔子滑步到讲台位（黑板左下角外侧）——主进程 relocate（forceGlide）：
   * 不走渲染侧 moveTo（其工作区夹取会让"窗底允许越界"的讲台位停在半路）；
   * forceGlide 跳过魔法流程（去讲课，不搞"被魔法球捕获"）。
   */
  glideToPodium(boardRect: Rect): void {
    const pet = this.getPet()
    if (!pet || pet.isDestroyed()) return
    const point = podiumPoint(boardRect, getPetScale())
    const size = podiumPetSize(getPetScale())
    void runRelocateAnimation(
      pet,
      { x: point.x, y: point.y, width: size.width, height: size.height },
      { forceGlide: true }
    )
  }

  /**
   * 下课回位：把宠物送回进入教学前的位置。
   * 宠物隐藏时 relocate 内部只静默改坐标（不强行显示）。
   */
  async returnHome(): Promise<void> {
    const pet = this.getPet()
    const home = this.homeRect
    this.homeRect = null
    if (!pet || pet.isDestroyed() || !home) return
    const from = pet.getBounds()
    console.log(`[teaching] 下课回位：宠物 ${from.x},${from.y} → ${home.x},${home.y}`)
    await runRelocateAnimation(pet, home)
  }

  /** 应用退出：不做回位动画（宠物窗随后销毁） */
  clearHome(): void {
    this.homeRect = null
  }
}
