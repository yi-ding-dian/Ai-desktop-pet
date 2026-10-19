/**
 * 睡眠 Zzz 覆盖层（2026-10-19，DOM/CSS 实现）。
 *
 * 为什么不用 3D Sprite：文字要清晰、不受材质/光照影响，纯 CSS 动画走 GPU 合成，
 * 对 400×400 的桌面窗口几乎零成本。挂在表情层的 stage（position:relative）里，
 * 只在睡姿模型可见时显示；唤醒/打断时淡出。
 */
import './zzz.css'
import { ZZZ_LEFT_PERCENT, ZZZ_TOP_PERCENT } from './config'

export class SleepZzzOverlay {
  private root: HTMLDivElement | null = null
  private visible = false

  /** 挂到渲染容器的相对定位层（通常是 FaceOverlay 创建的 stage） */
  attach(host: HTMLElement): void {
    this.detach()
    const root = document.createElement('div')
    root.className = 'pet-sleep-zzz'
    root.setAttribute('aria-hidden', 'true')
    root.style.left = `${ZZZ_LEFT_PERCENT}%`
    root.style.top = `${ZZZ_TOP_PERCENT}%`
    // 从下到上：小 z → 中 Z → 大 Z（参考睡姿图）
    for (const [index, char] of ['z', 'Z', 'Z'].entries()) {
      const span = document.createElement('span')
      span.className = `pet-sleep-zzz-char pet-sleep-zzz-char-${index + 1}`
      span.textContent = char
      root.appendChild(span)
    }
    host.appendChild(root)
    this.root = root
    this.applyVisible()
  }

  setVisible(value: boolean): void {
    if (this.visible === value) return
    this.visible = value
    this.applyVisible()
  }

  detach(): void {
    this.root?.remove()
    this.root = null
  }

  dispose(): void {
    this.detach()
  }

  private applyVisible(): void {
    this.root?.classList.toggle('is-visible', this.visible)
  }
}
