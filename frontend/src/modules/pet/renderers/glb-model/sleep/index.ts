/**
 * 睡眠状态编排（2026-10-19）：组合睡姿模型与 Zzz 覆盖层。
 *
 * 对外只暴露三件事：
 * - `setState(state)`：进入/退出 sleeping；
 * - `coversStand`：睡姿是否接管画面（渲染器据此隐藏站姿模型/表情/耳朵层）；
 * - `hitTest(raycaster)`：睡姿可见时接管命中判定。
 *
 * 模型未就绪/加载失败时全部回退：`coversStand=false`，站姿模型继续用现有
 * 程序化睡觉姿态（姿势下沉 + 闭眼 + Zzz 由 face 层负责）。
 */
import type * as THREE from 'three'
import type { PetState } from '../../../../../shared/protocol'
import { SleepModel } from './model'
import { SleepZzzOverlay } from './zzz'

export interface SleepAttachOptions {
  scene: THREE.Scene
  /** 相对定位的覆盖层宿主（通常是 FaceOverlay 的 stage） */
  overlayHost: HTMLElement
}

export class SleepController {
  private readonly model = new SleepModel()
  private readonly zzz = new SleepZzzOverlay()
  private state: PetState = 'idle'
  private attached = false

  attach(options: SleepAttachOptions): void {
    this.attached = true
    this.model.attach({ scene: options.scene })
    this.zzz.attach(options.overlayHost)
    this.syncVisibility()
  }

  /** 站姿模型就绪后调用（懒加载睡姿 GLB；standWidth 用于按宽度归一化） */
  preload(standWidth: number): void {
    this.model.preload(standWidth)
  }

  setState(state: PetState): void {
    this.state = state
    this.syncVisibility()
  }

  update(dt: number): void {
    this.model.update(dt)
    // 模型可能在 sleeping 期间才加载完成：加载后下一帧进入
    this.syncVisibility()
  }

  /** 睡姿是否接管画面（进入过渡开始 → 退出过渡结束） */
  get coversStand(): boolean {
    return this.model.visibleNow
  }

  /** raycaster 必须已 setFromCamera；返回 null 表示睡姿未接管 */
  hitTest(raycaster: THREE.Raycaster): boolean | null {
    return this.model.hitTest(raycaster)
  }

  detach(): void {
    this.zzz.detach()
    this.model.detach()
    this.attached = false
  }

  dispose(): void {
    this.zzz.dispose()
    this.model.dispose()
    this.attached = false
  }

  private syncVisibility(): void {
    if (!this.attached) return
    const sleeping = this.state === 'sleeping'
    if (sleeping && this.model.ready) {
      this.model.setVisible(true)
      this.zzz.setVisible(true)
    } else {
      this.model.setVisible(false)
      this.zzz.setVisible(false)
    }
  }
}
