/**
 * 3D 渲染器：PetRenderer 的第二个实现（Three.js 程序化几何拼装，零外部素材）。
 *
 * 分工：`models/*` 负责"搭出部件 + 专属逐帧写入"、animator.ts 负责"算每帧姿态"，
 * 本文件是外壳：模型选择 + 生命周期（mount/unmount/dispose）+ 渲染循环（rAF）+
 * 通用逐帧写入（applyFrame：根/头/眼/嘴/腮红/色偏/心形粒子）+ 相机/灯光/WebGL 管理。
 *
 * 多模型（2026-10-14 兔子上线）：模型 id 由 config.ts 的 resolvePetModelId() 决定
 * （localStorage `pet-model-3d` 可覆盖，默认 'rabbit'）；`new ThreeDRenderer(modelId)`
 * 也可显式指定。**将来由"角色系统"统一管理模型/角色选择（设计文档 §4.6）**。
 *
 * 渲染循环完全独立于 React（设计文档 §5.3）：React 只调用 mount/unmount 与指令方法，
 * 帧更新不触发 React 重渲染；Three.js 对象全程复用，仅改 position/rotation/scale/opacity。
 *
 * 生命周期与幂等性：
 * - mount 可重复调用（先卸旧逻辑，画布与 WebGL 上下文复用）；StrictMode 双挂载安全；
 * - unmount 停循环、摘画布（上下文保留，可再 mount）；
 * - dispose 释放几何/材质/WebGL 上下文，之后不可再用。
 */
import * as THREE from 'three'
import type { PetState } from '../../../../shared/protocol'
import type { PetReactionKind, PetRenderer, PetRendererName } from '../types'
import { resolvePetModelId, type PetModelId, type PetModel3D, type PetParts3D } from './config'
import { getPetModel3D } from './models'
import { PetAnimator3D, type PetFrame3D } from './animator'
import type { PetBuildResult3D } from './config'

/** dev 态日志（转发到主进程日志，便于无 devtools 验证）；生产构建自动剔除 */
const devLog = (msg: string): void => {
  if (import.meta.env.DEV) console.log(`[pet] ${msg}`)
}

// ------------------------------------------------------------------ 通用逐帧应用

/** 把一帧姿态写入**模型共用部件**（唯一接触共用场景对象的地方；模型专属件在其后由 applyExtras 写） */
function applyFrame(parts: PetParts3D, f: PetFrame3D): void {
  // 根：弹跳位移 + 呼吸/果冻缩放（根原点 = 脚底，缩放天然绕脚底）
  parts.root.position.y = f.offsetY
  parts.root.scale.set(f.scaleX, f.scaleY, f.scaleZ)

  // 身体倾斜（绕脚底）+ 前倾（兔子蹦跳）+ 头部姿态（相对身体）
  parts.tilt.rotation.set(f.bodyPitch, f.bodyYaw, f.bodyTilt)
  parts.head.rotation.set(f.headPitch, f.headYaw, f.headTilt)

  // 眼睛（左右共用材质，逐帧写一次即可）
  const eyes = parts.eyeL
  const roundVisible = f.eyeRound > 0.02
  const arcVisible = f.eyeArc > 0.02
  eyes.roundMaterials.white.opacity = f.eyeRound
  eyes.roundMaterials.pupil.opacity = f.eyeRound
  eyes.roundMaterials.highlight.opacity = f.eyeRound
  eyes.arcMaterial.opacity = f.eyeArc

  for (const eye of [parts.eyeL, parts.eyeR]) {
    eye.round.visible = roundVisible
    eye.arc.visible = arcVisible
    // 眨眼/眯眼：纵向压扁（横向轻微膨胀，squash 守恒感）
    const squashX = 1 + (1 - f.eyeOpen) * 0.12
    eye.round.scale.set(squashX, Math.max(0.02, f.eyeOpen), 1)
    // 瞳孔：注视偏移 + 缩放（两眼世界坐标一致，无镜像符号）
    eye.pupil.position.set(f.pupilX, f.pupilY, parts.eyePupilForward)
    eye.pupil.scale.setScalar(f.pupilScale)

    // 眉毛：怒眉内端下压（左负右正）/ 悲眉反号并整体上移；透明度取两者较大
    const browAlpha = Math.max(f.browAngry, f.browSad)
    const sign = eye === parts.eyeL ? -1 : 1
    eye.brow.visible = browAlpha > 0.02
    eye.browMaterial.opacity = browAlpha
    eye.brow.rotation.z =
      sign * (f.browAngry * eye.browParams.angryAngle - f.browSad * eye.browParams.angryAngle * 0.9)
    eye.brow.position.y = eye.browParams.baseY + f.browSad * eye.browParams.sadLift
  }

  // 嘴：上片微翘（表情）+ 下片开合（口型）
  parts.mouth.upper.rotation.x = parts.mouth.upperRest + f.beakLift
  parts.mouth.lower.rotation.x = parts.mouth.lowerRest + f.mouthOpen * parts.mouth.maxOpenAngle

  // 腮红：透明度（0–1 强度 × 模型最大不透明度）+ 颜色（angry 会变红）
  parts.blushMaterial.opacity = f.blushAlpha * parts.blushMaxOpacity
  parts.blushMaterial.color.set(f.blushColor)

  // 情绪色偏：身体材质在基色 ↔ tint 之间插值
  if (f.tintAlpha > 0.001) {
    C_BASE.set(parts.bodyBaseColor)
    C_MIX.copy(C_BASE).lerp(C_TINT.set(f.tintColor), Math.min(1, f.tintAlpha))
    parts.bodyMaterial.color.copy(C_MIX)
  } else {
    parts.bodyMaterial.color.set(parts.bodyBaseColor)
  }

  // 心形粒子（错开飘出）
  for (let i = 0; i < parts.hearts.length; i++) {
    const h = f.hearts[i]
    const mesh = parts.hearts[i]
    const mat = parts.heartMaterials[i]
    if (!h || h.opacity <= 0.02) {
      mesh.visible = false
      continue
    }
    const anchor = parts.heartAnchors[i].pos
    mesh.visible = true
    mesh.position.set(anchor.x + h.x, anchor.y + h.y, anchor.z + h.z)
    mesh.scale.setScalar(h.scale)
    mesh.rotation.z = h.rotZ
    mat.opacity = h.opacity
  }
}

/** 色偏插值用的临时对象（避免逐帧分配） */
const C_BASE = new THREE.Color()
const C_TINT = new THREE.Color()
const C_MIX = new THREE.Color()

// ------------------------------------------------------------------ 渲染器

export class ThreeDRenderer implements PetRenderer {
  readonly name: PetRendererName = 'three-d'

  /** 当前模型（id 由构造参数 / localStorage 决定） */
  private readonly model: PetModel3D
  private readonly animator: PetAnimator3D
  private readonly scene: THREE.Scene
  private readonly camera: THREE.PerspectiveCamera

  /** WebGL 渲染器（mount 时懒创建，unmount 保留复用，dispose 释放） */
  private webgl: THREE.WebGLRenderer | null = null
  /** 当前挂载的模型构建结果（parts + 模型专属 applyExtras 闭包） */
  private built: PetBuildResult3D | null = null
  private container: HTMLElement | null = null
  private resizeObserver: ResizeObserver | null = null
  private rafId: number | null = null
  private lastTs: number | null = null
  private disposed = false
  /** 窗口移动测速（拟人步态节奏用）：上一帧窗口位置 + 平滑速度（px/s） */
  private lastScreenPos = { x: 0, y: 0, ts: -1 }
  private moveSpeedSmooth = 0
  /** WebGL 创建失败标记（软渲染受限等）：保持空容器、不抛错 */
  private webglFailed = false
  /** 口型日志节流状态（P2 口型驱动逐帧调用 setMouth，不能每帧打日志） */
  private lastMouthLog = { ts: 0, level: -1 }

  /**
   * @param modelId 模型 id（缺省 = localStorage 覆盖值，再缺省 = 'rabbit'）
   */
  constructor(modelId?: PetModelId) {
    this.model = getPetModel3D(modelId ?? resolvePetModelId())
    this.animator = new PetAnimator3D(this.model.metrics, this.model.poses, this.model.walkStyle)

    this.scene = new THREE.Scene()

    const cam = this.model.metrics.camera
    this.camera = new THREE.PerspectiveCamera(cam.fov, 1, 0.1, 100)
    this.camera.position.set(cam.position.x, cam.position.y, cam.position.z)
    this.camera.lookAt(cam.lookAt.x, cam.lookAt.y, cam.lookAt.z)

    // 光照按模型渲染风格装配：
    if (this.model.style === 'fluffy') {
      // soft 3D 毛绒（兔子 v3）：大面积柔和漫射光（环境 + 半球为主）+ 温柔主光/补光——
      // 低对比、无硬阴影；sheen 绒毛边缘光需要充足环境照度。注意 three 漫反射含 1/π 因子，
      // 光照总量按 π 配平（奶油白面约为纯白）
      const ambient = new THREE.AmbientLight(0xfffbf5, 2.1)
      const hemi = new THREE.HemisphereLight(0xfff8ef, 0xe8e2da, 1.2)
      const key = new THREE.DirectionalLight(0xfff3e4, 0.5)
      key.position.set(1.8, 3.2, 2.8)
      const fill = new THREE.DirectionalLight(0xf4f2ff, 0.25)
      fill.position.set(-2.4, 1.0, 1.6)
      this.scene.add(ambient, hemi, key, fill)
    } else if (this.model.style === 'toon') {
      // 卡通平光（兔子）：环境光为主、方向光弱化——配 MeshToonMaterial 分带 + 描边，
      // 消除写实体积阴影感；白兔要"干净的白"：注意 three 漫反射含 1/π 因子，
      // 光照总量需 ≈ π 才能把白面拉到纯白（数值按此配平）
      const ambient = new THREE.AmbientLight(0xffffff, 1.7)
      const hemi = new THREE.HemisphereLight(0xffffff, 0xe6ecf5, 0.55)
      const key = new THREE.DirectionalLight(0xffffff, 1.35)
      key.position.set(1.6, 3.0, 2.6)
      this.scene.add(ambient, hemi, key)
    } else {
      // 柔和三点光照（软胶玩具：暖主光 + 冷补光 + 半球环境光）——企鹅沿用
      const hemi = new THREE.HemisphereLight(0xffffff, 0xcdd4e8, 1.15)
      const key = new THREE.DirectionalLight(0xfff2e2, 1.65)
      key.position.set(2.2, 3.4, 3.0)
      const fill = new THREE.DirectionalLight(0xc9d6ff, 0.75)
      fill.position.set(-2.8, 1.2, 2.2)
      this.scene.add(hemi, key, fill)
    }
  }

  /** 当前模型 id（调试/日志用） */
  get modelId(): PetModelId {
    return this.model.id
  }

  mount(container: HTMLElement): void {
    if (this.disposed) return
    this.unmount()

    this.container = container

    // ① 模型部件（几何/材质每次 mount 重建，保证 dispose 后不复用已释放资源）
    this.built = this.model.build()
    this.scene.add(this.built.parts.group)

    // ② WebGL 上下文（懒创建 + 复用；失败则保持空容器）
    if (!this.webgl && !this.webglFailed) {
      try {
        this.webgl = new THREE.WebGLRenderer({
          alpha: true, // 透明背景（桌面宠物窗口）
          antialias: true,
          powerPreference: 'default'
        })
        this.webgl.setClearAlpha(0)
        this.webgl.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
        this.webgl.domElement.addEventListener('webglcontextlost', (e) => {
          e.preventDefault()
          // dispose 流程内的主动丢弃不算异常（见 dispose 注释）
          if (!this.disposed) devLog('renderer(procedural-3d) WebGL 上下文丢失（等待恢复）')
        })
        devLog('renderer(procedural-3d) WebGL 上下文已创建')
      } catch (err) {
        this.webglFailed = true
        console.warn('[pet] procedural-3d WebGL 初始化失败（保持空容器）：', err)
      }
    }
    if (this.webgl) {
      const canvas = this.webgl.domElement
      canvas.style.display = 'block'
      canvas.style.width = '100%'
      canvas.style.height = '100%'
      container.appendChild(canvas)
      this.applySize()
    }

    // ③ 容器尺寸自适应
    this.resizeObserver = new ResizeObserver(() => this.applySize())
    this.resizeObserver.observe(container)

    // ④ 先画一帧静态姿态，避免首帧前出现"未造型"的部件
    const f0 = this.animator.update(0)
    applyFrame(this.built.parts, f0)
    this.built.applyExtras(f0)
    this.renderOnce()

    this.lastTs = null
    this.rafId = requestAnimationFrame(this.tick)
    devLog(`renderer(${this.name}) mounted（model=${this.model.id}「${this.model.label}」）`)
  }

  unmount(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId)
      this.rafId = null
    }
    this.resizeObserver?.disconnect()
    this.resizeObserver = null
    if (this.built) {
      this.scene.remove(this.built.parts.group)
      this.built.parts.dispose()
      this.built = null
    }
    this.webgl?.domElement.remove()
    this.container = null
    this.lastTs = null
  }

  dispose(): void {
    this.unmount()
    this.disposed = true // 先置位：contextlost 监听据此静默（主动丢弃不算异常）
    if (this.webgl) {
      // 显式丢弃 WebGL 上下文（Chromium 有活跃上下文数量上限；仅 dispose() 不保证立刻释放，
      // HMR 反复重建时会累积出 "Too many active WebGL contexts"）
      try {
        this.webgl.dispose()
        this.webgl.forceContextLoss()
      } catch (err) {
        console.warn('[pet] procedural-3d 释放 WebGL 上下文异常：', err)
      }
      this.webgl = null
    }
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
    // 日志节流：口型驱动（voice 域 Web Audio 包络）逐帧调用；仅在变化 >0.12 或距上次 >500ms 时打印，
    // 调试键 M（0↔1 切换）仍能即时看到日志
    const now = Date.now()
    if (Math.abs(level - this.lastMouthLog.level) > 0.12 || now - this.lastMouthLog.ts > 500) {
      this.lastMouthLog = { ts: now, level }
      devLog(`mouth -> ${level.toFixed(2)}`)
    }
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
      this.measureMoveSpeed(ts)
      return
    }
    const dt = (ts - this.lastTs) / 1000
    this.lastTs = ts
    // 窗口实际移动速度 → animator（拟人步态节奏与窗口移动速度匹配；零接口改动：
    // 直接读 window.screenX/screenY 差分，见 measureMoveSpeed）
    this.measureMoveSpeed(ts)
    this.animator.setLocomotionSpeed(this.moveSpeedSmooth)
    if (!this.built) return
    const f = this.animator.update(dt)
    applyFrame(this.built.parts, f)
    this.built.applyExtras(f)
    this.renderOnce()
  }

  /**
   * 测窗口移动速度（px/s，指数平滑）：walk 行为由主进程按 distance/duration_ms 缓动移动窗口
   * （见 electron/window/move.ts），渲染进程直接读 screenX/screenY 差分即可获得"真实步速"，
   * 无需行为引擎传参（保持 PetRenderer 接口零改动）。拖动窗口时的速度同样会进入步态——
   * 但 dragging 状态下 animator 不迈步，无影响。
   */
  private measureMoveSpeed(ts: number): void {
    const x = window.screenX
    const y = window.screenY
    const prev = this.lastScreenPos
    if (prev.ts >= 0) {
      const dt = (ts - prev.ts) / 1000
      if (dt > 0.002) {
        const v = Math.hypot(x - prev.x, y - prev.y) / dt
        const k = Math.min(1, dt / 0.12)
        this.moveSpeedSmooth += (v - this.moveSpeedSmooth) * k
      }
    }
    this.lastScreenPos = { x, y, ts }
  }

  /** 相机纵横比/画布尺寸跟随容器（0 尺寸时用配置兜底） */
  private applySize(): void {
    if (!this.webgl || !this.container) return
    const w = this.container.clientWidth || this.model.metrics.camera.fallbackSize
    const h = this.container.clientHeight || this.model.metrics.camera.fallbackSize
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
    this.webgl.setSize(w, h, false)
  }

  private renderOnce(): void {
    if (this.webgl && this.built) this.webgl.render(this.scene, this.camera)
  }
}

export { PENGUIN_3D_CONFIG } from './models/penguin'
export { RABBIT_3D_CONFIG } from './models/rabbit'
export type { PetModelId } from './config'
