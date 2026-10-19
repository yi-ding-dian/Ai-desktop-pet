/**
 * 睡眠状态编排（2026-10-19）：每次入睡随机选一个睡姿模型，不中途切换。
 *
 * - 50%（可调）选深睡模型（有口水）：入睡后口水先隐藏，满 10 秒用 shader 淡入；
 * - 50% 选浅睡模型（无口水）：整场睡眠都没有口水；
 * - 两个模型都保留，选中哪个就只显示哪个；加载失败回退另一个，都失败回退站姿。
 */
import type * as THREE from 'three'
import type { PetState } from '../../../../../shared/protocol'
import {
  DEEP_MODEL_PROBABILITY,
  DEEP_SLEEP_DELAY_SECONDS,
  DROOL_FADE_SECONDS,
  SLEEP_DEEP_MODEL_URL,
  SLEEP_LIGHT_MODEL_URL,
  SLEEP_WIDTH_RATIO_DEEP,
  SLEEP_WIDTH_RATIO_LIGHT
} from './config'
import { SleepModel } from './model'
import { SleepZzzOverlay } from './zzz'

export interface SleepAttachOptions {
  scene: THREE.Scene
  /** 相对定位的覆盖层宿主（通常是 FaceOverlay 的 stage） */
  overlayHost: HTMLElement
}

export class SleepController {
  private readonly light = new SleepModel('light')
  private readonly deep = new SleepModel('deep')
  private readonly zzz = new SleepZzzOverlay()
  private sleeping = false
  /** 本次睡眠随机选中的模型（进入时决定，睡眠期间不变） */
  private preferDeep = false
  /** 本次睡眠已持续秒数（只用于深睡模型口水淡入） */
  private elapsed = 0
  private attached = false

  attach(options: SleepAttachOptions): void {
    this.attached = true
    this.light.attach({ scene: options.scene })
    this.deep.attach({ scene: options.scene })
    this.zzz.attach(options.overlayHost)
    this.applyVisibility()
  }

  /** 站姿模型就绪后调用：两个睡姿模型并行懒加载 */
  preload(standWidth: number): void {
    this.light.preload(standWidth, SLEEP_LIGHT_MODEL_URL, SLEEP_WIDTH_RATIO_LIGHT)
    this.deep.preload(standWidth, SLEEP_DEEP_MODEL_URL, SLEEP_WIDTH_RATIO_DEEP)
  }

  setState(state: PetState): void {
    const next = state === 'sleeping'
    if (next === this.sleeping) return
    this.sleeping = next
    this.elapsed = 0
    if (next) {
      // 每次入睡随机一次；睡眠期间不切换模型
      this.preferDeep = Math.random() < DEEP_MODEL_PROBABILITY
      this.deep.setDroolAlpha(0)
    } else {
      this.deep.setDroolAlpha(1)
    }
    this.applyVisibility()
  }

  update(dt: number): void {
    if (this.sleeping) {
      this.elapsed += dt
      if (this.preferDeep) {
        // 入睡 10 秒后，口水在 0.8 秒内从 0 淡入到 1
        const progress = Math.min(
          1,
          Math.max(0, (this.elapsed - DEEP_SLEEP_DELAY_SECONDS) / DROOL_FADE_SECONDS)
        )
        this.deep.setDroolAlpha(progress)
      }
    }
    this.light.update(dt)
    this.deep.update(dt)
    this.applyVisibility()
  }

  /** 睡姿是否接管画面（当前选中的模型可见，含过渡） */
  get coversStand(): boolean {
    return this.light.visibleNow || this.deep.visibleNow
  }

  /** raycaster 必须已 setFromCamera；返回 null 表示睡姿未接管 */
  hitTest(raycaster: THREE.Raycaster): boolean | null {
    const deepHit = this.deep.hitTest(raycaster)
    if (deepHit === true) return true
    const lightHit = this.light.hitTest(raycaster)
    if (lightHit !== null) return lightHit
    return deepHit
  }

  detach(): void {
    this.zzz.detach()
    this.light.detach()
    this.deep.detach()
    this.attached = false
  }

  dispose(): void {
    this.zzz.dispose()
    this.light.dispose()
    this.deep.dispose()
    this.attached = false
  }

  private applyVisibility(): void {
    if (!this.attached) return
    if (!this.sleeping) {
      this.light.setVisible(false)
      this.deep.setVisible(false)
      this.zzz.setVisible(false)
      return
    }

    const primary = this.preferDeep ? this.deep : this.light
    const fallback = this.preferDeep ? this.light : this.deep
    if (primary.ready) {
      primary.setVisible(true)
      fallback.setVisible(false)
    } else if (fallback.ready) {
      // 选中的模型还没加载好/加载失败：先用另一个
      fallback.setVisible(true)
      primary.setVisible(false)
    }
    this.zzz.setVisible(this.light.visibleNow || this.deep.visibleNow)
  }
}
