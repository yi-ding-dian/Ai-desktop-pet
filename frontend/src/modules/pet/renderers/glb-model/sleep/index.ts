/**
 * 睡眠状态编排（2026-10-19；2026-10-25 收敛为单一浅睡模型）。
 *
 * - 进入 sleeping 显示唯一睡姿模型（无口水）；
 * - 模型加载失败回退站姿睡觉（表情/耳朵层仍按 sleeping 处理）；
 * - Zzz 覆盖层与睡姿模型同进同出。
 */
import type * as THREE from 'three'
import type { PetState } from '../../../../../shared/protocol'
import { SLEEP_MODEL_URL, SLEEP_WIDTH_RATIO } from './config'
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
  private sleeping = false
  private attached = false

  attach(options: SleepAttachOptions): void {
    this.attached = true
    this.model.attach({ scene: options.scene })
    this.zzz.attach(options.overlayHost)
    this.applyVisibility()
  }

  /** 站姿模型就绪后调用：睡姿模型懒加载 */
  preload(standWidth: number): void {
    this.model.preload(standWidth, SLEEP_MODEL_URL, SLEEP_WIDTH_RATIO)
  }

  setState(state: PetState): void {
    const next = state === 'sleeping'
    if (next === this.sleeping) return
    this.sleeping = next
    this.applyVisibility()
  }

  update(dt: number): void {
    this.model.update(dt)
    this.applyVisibility()
  }

  /** 睡姿是否接管画面（当前模型可见，含过渡） */
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

  private applyVisibility(): void {
    if (!this.attached) return
    this.model.setVisible(this.sleeping)
    this.zzz.setVisible(this.sleeping && this.model.visibleNow)
  }
}
