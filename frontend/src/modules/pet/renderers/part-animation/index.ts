/**
 * 部件动画渲染器：PetRenderer 的第一个实现（纯 SVG + rAF，零依赖）。
 *
 * 分工：penguin.ts 负责"画出部件"、animator.ts 负责"算每帧姿态"，
 * 本文件是外壳：生命周期（mount/unmount/dispose）+ 渲染循环（rAF）+ 逐帧写入 DOM（applyFrame）。
 *
 * 渲染循环完全独立于 React（设计文档 §5.3）：React 只调用 mount/unmount 与指令方法，
 * 帧更新不触发 React 重渲染；DOM 部件全程复用，仅改属性（transform/opacity/d）。
 */
import type { PetState } from '../../../../shared/protocol'
import type { PetReactionKind, PetRenderer, PetRendererName } from '../types'
import { PENGUIN_CONFIG, type PenguinConfig } from './config'
import { buildPenguin, buildMouthPath, type PenguinParts } from './penguin'
import { PetAnimator, type PetFrame } from './animator'

/** dev 态日志（转发到主进程日志，便于无 devtools 验证）；生产构建自动剔除 */
const devLog = (msg: string): void => {
  if (import.meta.env.DEV) console.log(`[pet] ${msg}`)
}

// ------------------------------------------------------------------ 逐帧应用

/** 把一帧姿态写入 SVG（唯一接触 DOM 的地方） */
function applyFrame(parts: PenguinParts, f: PetFrame, cfg: PenguinConfig): void {
  // 轴心：脚底中心（呼吸缩放与倾斜都绕它，像站在原地的钟摆）
  const px = cfg.body.cx
  const py = cfg.feet.left.y + cfg.feet.left.ry

  // 根组：弹跳位移 + 呼吸缩放（顺序：先平移再绕轴心缩放）
  parts.root.setAttribute(
    'transform',
    `translate(0 ${f.offsetY.toFixed(2)}) translate(${px} ${py}) scale(${f.scaleX.toFixed(4)} ${f.scaleY.toFixed(4)}) translate(${-px} ${-py})`
  )
  // 倾斜组：情绪倾斜 + 待机摇摆
  parts.tilt.setAttribute('transform', `rotate(${f.rotate.toFixed(2)} ${px} ${py})`)

  // 呆毛：绕根部弯曲
  parts.hair.setAttribute(
    'transform',
    `rotate(${f.hairBend.toFixed(2)} ${cfg.hair.rootX} ${cfg.hair.rootY})`
  )
  // 翅膀：绕根部旋转（左翅正角=下垂，负角=上抬；右翅镜像取反）
  parts.wingL.setAttribute(
    'transform',
    `rotate(${f.wingAngle.toFixed(2)} ${cfg.wings.left.rootX} ${cfg.wings.left.rootY})`
  )
  parts.wingR.setAttribute(
    'transform',
    `rotate(${(-f.wingAngle).toFixed(2)} ${cfg.wings.right.rootX} ${cfg.wings.right.rootY})`
  )

  // 身体情绪色偏
  parts.bodyTint.setAttribute('fill', f.tintColor)
  parts.bodyTint.setAttribute('opacity', f.tintAlpha.toFixed(3))

  // 眼睛（右眼为镜像组：屏幕级 lookX 在局部取反）
  applyEye(parts.eyeL, f, 1)
  applyEye(parts.eyeR, f, -1)

  // 嘴
  parts.mouth.setAttribute(
    'd',
    buildMouthPath(cfg.mouth.cx, cfg.mouth.cy, f.mouthWidth, f.mouthCurve, f.mouthOpen)
  )

  // 腮红
  for (const blush of [parts.blushL, parts.blushR]) {
    blush.setAttribute('opacity', f.blushAlpha.toFixed(3))
    blush.setAttribute('fill', f.blushColor)
  }

  // 心形粒子
  cfg.hearts.anchors.forEach((_, i) => {
    const h = f.hearts[i]
    const el = parts.hearts[i]
    if (!h) {
      el.setAttribute('opacity', '0')
      return
    }
    el.setAttribute('opacity', h.opacity.toFixed(3))
    el.setAttribute(
      'transform',
      `translate(${h.x.toFixed(1)} ${h.y.toFixed(1)}) scale(${h.scale.toFixed(3)}) rotate(${h.rotate.toFixed(2)})`
    )
  })
}

/** 单只眼睛的逐帧写入（lookSign：右眼镜像组传 -1） */
function applyEye(eye: PenguinParts['eyeL'], f: PetFrame, lookSign: number): void {
  const inward = PENGUIN_CONFIG.eyes.pupil.inward
  const down = PENGUIN_CONFIG.eyes.pupil.down

  eye.round.setAttribute('opacity', f.eyeRound.toFixed(3))
  eye.arc.setAttribute('opacity', f.eyeArc.toFixed(3))
  eye.browAngry.setAttribute('opacity', f.browAngry.toFixed(3))
  eye.browSad.setAttribute('opacity', f.browSad.toFixed(3))
  // 眨眼/半闭：绕眼中心纵向压缩（局部坐标原点即眼中心）
  eye.lid.setAttribute('transform', `scale(1 ${f.eyelidScale.toFixed(4)})`)
  // 瞳孔：默认内偏 + 视线偏移 + 缩放
  eye.pupil.setAttribute(
    'transform',
    `translate(${(inward + lookSign * f.pupilX).toFixed(2)} ${(down + f.pupilY).toFixed(2)}) scale(${f.pupilScale.toFixed(3)})`
  )
}

// ------------------------------------------------------------------ 渲染器

export class PartAnimationRenderer implements PetRenderer {
  readonly name: PetRendererName = 'part-animation'

  private readonly cfg: PenguinConfig
  private readonly animator: PetAnimator

  private container: HTMLElement | null = null
  private parts: PenguinParts | null = null
  private rafId: number | null = null
  private lastTs: number | null = null
  private disposed = false

  constructor(cfg: PenguinConfig = PENGUIN_CONFIG) {
    this.cfg = cfg
    this.animator = new PetAnimator(cfg)
  }

  mount(container: HTMLElement): void {
    if (this.disposed) return
    this.unmount()

    this.container = container
    this.parts = buildPenguin(this.cfg)
    container.appendChild(this.parts.svg)

    // 先画一帧静态姿态，避免首帧前出现"未造型"的原始部件
    applyFrame(this.parts, this.animator.update(0), this.cfg)

    this.lastTs = null
    this.rafId = requestAnimationFrame(this.tick)
    devLog(`renderer(${this.name}) mounted`)
  }

  unmount(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId)
      this.rafId = null
    }
    this.parts?.svg.remove()
    this.parts = null
    this.container = null
    this.lastTs = null
  }

  dispose(): void {
    this.unmount()
    this.disposed = true
    devLog(`renderer(${this.name}) disposed`)
  }

  // ---------------- 指令（转发 animator；未挂载时调用也安全） ----------------

  setEmotion(emotion: string, intensity = 1): void {
    this.animator.setEmotion(emotion, intensity)
    devLog(`emotion -> ${emotion} (intensity=${intensity})`)
  }

  setState(state: PetState): void {
    this.animator.setState(state)
    devLog(`state -> ${state}`)
  }

  setMouth(level: number): void {
    this.animator.setMouth(level)
    devLog(`mouth -> ${level.toFixed(2)}`)
  }

  playReaction(kind: PetReactionKind): void {
    this.animator.playReaction(kind)
    devLog(`reaction -> ${kind}`)
  }

  // ---------------- 渲染循环 ----------------

  private readonly tick = (ts: number): void => {
    this.rafId = requestAnimationFrame(this.tick)
    if (this.lastTs === null) {
      this.lastTs = ts
      return
    }
    const dt = (ts - this.lastTs) / 1000
    this.lastTs = ts
    if (!this.parts) return
    applyFrame(this.parts, this.animator.update(dt), this.cfg)
  }
}

export { PENGUIN_CONFIG }
