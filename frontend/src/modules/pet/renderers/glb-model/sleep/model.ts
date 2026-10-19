/**
 * 睡姿模型加载与过渡（2026-10-19）。
 *
 * 独立于站姿模型：
 * - 单独一个 GLB（压缩后 1.3MB），加载失败不影响站姿渲染；
 * - 按站姿宽度归一化、居中贴地，避免切换前后"突然变小/变宽"；
 * - `setVisible(true/false)` 走 0.36s 缩放/位移过渡；
 * - 腹部呼吸与口水摆动由 motion.ts 的顶点着色器负责。
 */
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { disposeObjectResources } from '../dispose-resources'
import { applySleepMotion, type SleepMotion } from './motion'
import {
  SLEEP_ENTER_OFFSET_Y,
  SLEEP_ENTER_SCALE,
  SLEEP_LIFT_Y,
  SLEEP_TRANSITION_SECONDS
} from './config'

export interface SleepModelHost {
  scene: THREE.Scene
}

type SleepState = 'idle' | 'loading' | 'ready' | 'failed'

/** 平滑过渡曲线（0→1） */
function smoothstep(t: number): number {
  const u = Math.min(1, Math.max(0, t))
  return u * u * (3 - 2 * u)
}

export class SleepModel {
  /** 日志/调试用：light / deep */
  private readonly label: string
  private host: SleepModelHost | null = null
  private root: THREE.Group | null = null
  private model: THREE.Object3D | null = null
  private motion: SleepMotion | null = null
  private state: SleepState = 'idle'
  private token = 0
  private disposed = false

  /** 逻辑上是否处于睡姿（进入过渡开始 → 退出过渡结束） */
  private visible = false
  /** 当前过渡（秒） */
  private transition: { kind: 'enter' | 'exit'; elapsed: number } | null = null
  /** 口水目标 alpha（模型未就绪时先记住，加载完成后应用，避免一帧闪现） */
  private droolAlpha = 1

  constructor(label = 'sleep') {
    this.label = label
  }

  attach(host: SleepModelHost): void {
    this.host = host
    if (this.root && this.root.parent !== host.scene) host.scene.add(this.root)
  }

  /** 从场景摘除（保留资源；重新 attach 时挂回） */
  detach(): void {
    if (this.root?.parent) this.root.parent.remove(this.root)
  }

  /** 懒加载：站姿模型就绪后调用；standWidth 用于按宽度归一化，widthRatio 区分浅睡/深睡 */
  preload(standWidth: number, url: string, widthRatio: number): void {
    if (this.disposed || this.state !== 'idle') return
    this.state = 'loading'
    const token = ++this.token
    const loader = new GLTFLoader()
    loader.load(
      url,
      (gltf) => {
        if (this.disposed || token !== this.token) {
          disposeObjectResources(gltf.scene)
          return
        }
        this.setup(gltf.scene, standWidth, widthRatio)
      },
      undefined,
      (err) => {
        if (this.disposed || token !== this.token) return
        this.state = 'failed'
        console.warn(`[pet] 睡姿模型(${this.label})加载失败（回退）：`, url, err)
      }
    )
  }

  get ready(): boolean {
    return this.state === 'ready' && this.root !== null
  }

  /** 睡姿当前是否"占着画面"（含进入/退出过渡） */
  get visibleNow(): boolean {
    return this.visible || this.transition !== null
  }

  get transitioning(): boolean {
    return this.transition !== null
  }

  setVisible(value: boolean): void {
    if (!this.ready || !this.root) return
    if (value) {
      if (this.visible) return
      this.visible = true
      this.transition = { kind: 'enter', elapsed: 0 }
      this.root.visible = true
      return
    }
    // 退出：已退出且没有进行中的进入过渡 → 幂等返回。
    // 注意不能每帧重置 elapsed，否则 syncVisibility 每帧调用会让过渡永远走不完。
    if (!this.visible && this.transition?.kind !== 'enter') return
    this.visible = false
    this.transition = { kind: 'exit', elapsed: 0 }
    this.root.visible = true
  }

  /** 口水显隐（深睡模型 0→1 淡入；浅睡模型没有口水顶点，调用无害） */
  setDroolAlpha(value: number): void {
    this.droolAlpha = value < 0 ? 0 : value > 1 ? 1 : value
    this.motion?.setDroolAlpha(this.droolAlpha)
  }

  update(dt: number): void {
    const root = this.root
    if (!root) return

    if (this.visible && this.motion) this.motion.update(dt)

    const transition = this.transition
    if (!transition) return
    transition.elapsed += dt
    const u = smoothstep(transition.elapsed / SLEEP_TRANSITION_SECONDS)

    if (transition.kind === 'enter') {
      root.scale.setScalar(SLEEP_ENTER_SCALE + (1 - SLEEP_ENTER_SCALE) * u)
      root.position.y = SLEEP_LIFT_Y + SLEEP_ENTER_OFFSET_Y * (1 - u)
      if (u >= 1) {
        root.scale.setScalar(1)
        root.position.y = SLEEP_LIFT_Y
        this.transition = null
      }
    } else {
      root.scale.setScalar(1 - (1 - SLEEP_ENTER_SCALE) * u)
      root.position.y = SLEEP_LIFT_Y + SLEEP_ENTER_OFFSET_Y * u
      if (u >= 1) {
        root.visible = false
        this.visible = false
        this.transition = null
      }
    }
  }

  /**
   * 命中判定：睡姿可见时返回 boolean；不可见/未就绪返回 null（调用方回退站姿）。
   * raycaster 必须已由调用方 setFromCamera。
   */
  hitTest(raycaster: THREE.Raycaster): boolean | null {
    if (!this.root || !this.ready || !this.visible) return null
    this.root.updateMatrixWorld()
    return raycaster.intersectObject(this.root, true).length > 0
  }

  dispose(): void {
    this.disposed = true
    this.token++
    if (this.root) {
      if (this.root.parent) this.root.parent.remove(this.root)
      disposeObjectResources(this.root)
    }
    this.root = null
    this.model = null
    this.motion = null
    this.state = 'idle'
    this.visible = false
    this.transition = null
    this.host = null
  }

  // ------------------------------------------------------------------ 内部

  private setup(loaded: THREE.Object3D, standWidth: number, widthRatio: number): void {
    // ① 材质微调（与站姿模型一致：卡通兔非金属，避免高 metalness 发黑）
    loaded.traverse((object) => {
      const mesh = object as THREE.Mesh
      if (!mesh.isMesh) return
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
      for (const material of materials) {
        const standard = material as THREE.MeshStandardMaterial
        if (typeof standard.metalness === 'number' && standard.metalness > 0.1) {
          standard.metalness = 0.1
        }
      }
    })

    // ② 居中 + 贴地（模型节点自带绕 X 轴旋转，Box3 已含全部变换）
    const box = new THREE.Box3().setFromObject(loaded)
    const center = box.getCenter(new THREE.Vector3())
    loaded.position.x -= center.x
    loaded.position.z -= center.z
    loaded.position.y -= box.min.y

    // ③ 按站姿宽度归一化（趴睡更宽更矮，按高度归一化会显得过大）
    const width = Math.max(0.001, box.max.x - box.min.x)
    const targetWidth = Math.max(0.2, standWidth * widthRatio)
    loaded.scale.multiplyScalar(targetWidth / width)

    // ④ 缩放后重新贴地 + 额外抬高
    const box2 = new THREE.Box3().setFromObject(loaded)
    const center2 = box2.getCenter(new THREE.Vector3())
    loaded.position.x -= center2.x
    loaded.position.z -= center2.z
    loaded.position.y -= box2.min.y
    loaded.position.y += SLEEP_LIFT_Y

    // ⑤ 姿态根组：过渡只写 root，不碰模型内部归一化
    const root = new THREE.Group()
    root.add(loaded)
    root.visible = false
    root.scale.setScalar(SLEEP_ENTER_SCALE)
    root.position.y = SLEEP_LIFT_Y + SLEEP_ENTER_OFFSET_Y
    this.root = root
    this.model = loaded

    // ⑥ 腹部呼吸（只作用于睡姿模型 clone 出来的材质）
    this.motion = applySleepMotion(loaded, { droolAlpha: this.label === 'deep' })
    this.motion?.setDroolAlpha(this.droolAlpha)

    this.state = 'ready'
    this.host?.scene.add(root)
    if (this.visible) {
      // 加载期间已经进入 sleeping：立即开始进入过渡
      root.visible = true
      this.transition = { kind: 'enter', elapsed: 0 }
    }
  }
}
