/**
 * 单个边缘动作模型的加载与定位（2026-10-20）。
 *
 * 与睡姿子模块同一套思路：独立 GLB、站姿就绪后懒加载、失败不影响站姿；
 * 区别在于**定位锚点**——不是"居中贴地"，而是按动作把模型的切面/双手对齐画布边缘：
 * - left：包围盒左边对齐画布左边缘（身体切面 = 屏幕外）；
 * - right：包围盒右边对齐画布右边缘；
 * - top：包围盒上边对齐画布上边缘（双手抓边）。
 *
 * 显示程度用 0→1 的 progress 推进（进入 +1、退出 -1），中途可反向，避免拖拽来回时跳变。
 */
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { disposeObjectResources } from '../dispose-resources'
import { EdgeEarMotion } from './ears'
import {
  EDGE_BREATHE_AMPLITUDE,
  EDGE_BREATHE_FREQ,
  EDGE_DEPTH_SAFETY,
  EDGE_ENTER_OFFSET_Y,
  EDGE_ENTER_SCALE,
  EDGE_SIDE_OVERLAP,
  EDGE_TRANSITION_SECONDS
} from './config'

/** 边缘动作种类（top = 悬挂；left/right = 探头；bottom = 趴睡贴底） */
export type EdgeKind = 'left' | 'right' | 'top' | 'bottom'

/** 相机参数（贴边锚点按"模型前表面深度"重算可见范围，而不是 z=0 平面） */
export interface EdgeView {
  /** 相机到 z=0 平面的距离（世界单位） */
  cameraDist: number
  /** tan(垂直 FOV / 2) */
  tanHalfFovY: number
  /** 画布宽高比 */
  aspect: number
  /** 相机 lookAt 高度（世界单位） */
  lookY: number
}

export interface EdgeModelHost {
  scene: THREE.Scene
}

type EdgeModelState = 'idle' | 'loading' | 'ready' | 'failed'

/** dev 态日志（转发到主进程日志）；生产构建自动剔除 */
const devLog = (msg: string): void => {
  if (import.meta.env.DEV) console.log(`[pet] ${msg}`)
}

function smoothstep(t: number): number {
  const u = Math.min(1, Math.max(0, t))
  return u * u * (3 - 2 * u)
}

export class EdgeModel {
  private readonly kind: EdgeKind
  private readonly url: string
  private host: EdgeModelHost | null = null
  private root: THREE.Group | null = null
  private model: THREE.Object3D | null = null
  private state: EdgeModelState = 'idle'
  private token = 0
  private disposed = false

  /** 定位锚点（模型居中后，由 view 计算） */
  private baseX = 0
  private baseY = 0
  private width = 0
  private height = 0
  /** 前表面深度：包围盒 z 上限（最靠近相机），贴边锚点按它重算可见范围 */
  private zMax = 0
  /**
   * 贴边轮廓带内的前表面深度（2026-10-20）：取贴近贴边侧（左/右/上/下）那一条
   * 轮廓顶点的最大 z。用它取代整只模型的 zMax，切面能贴得更近，同时该侧轮廓不裁。
   */
  private edgeDepth = 0
  private view: EdgeView | null = null
  /** 目标宽度（世界单位）：仅底部睡姿按站姿宽度归一化，左右/悬挂保持原尺寸 */
  private targetWidth: number | null = null

  /** 显示程度 0（完全隐藏）→ 1（完全显示） */
  private progress = 0
  private target = 0
  private elapsed = 0
  /** 耳朵顶点微动（悬挂/左右探头，幅度同站姿的"活着感"） */
  private readonly earMotion = new EdgeEarMotion()

  constructor(kind: EdgeKind, url: string) {
    this.kind = kind
    this.url = url
  }

  attach(host: EdgeModelHost): void {
    this.host = host
    if (this.root && this.root.parent !== host.scene) host.scene.add(this.root)
  }

  /** 从场景摘除（保留资源；重新 attach 时挂回） */
  detach(): void {
    if (this.root?.parent) this.root.parent.remove(this.root)
  }

  /** 站姿模型就绪后调用（view 由渲染器 setView 提供；未提供时先按原点摆放，就绪后补算） */
  preload(): void {
    if (this.disposed || this.state !== 'idle') return
    this.state = 'loading'
    const token = ++this.token
    const loader = new GLTFLoader()
    loader.load(
      this.url,
      (gltf) => {
        if (this.disposed || token !== this.token) {
          disposeObjectResources(gltf.scene)
          return
        }
        this.setup(gltf.scene)
      },
      undefined,
      (err) => {
        if (this.disposed || token !== this.token) return
        this.state = 'failed'
        console.warn(`[pet] 边缘模型(${this.kind})加载失败（回退站姿）：`, this.url, err)
      }
    )
  }

  get ready(): boolean {
    return this.state === 'ready' && this.root !== null
  }

  get visibleNow(): boolean {
    return this.progress > 0
  }

  setView(view: EdgeView): void {
    this.view = view
    this.applyAnchor()
  }

  /** 目标宽度（世界单位，preload 前调用）：底部睡姿按它归一化体量 */
  setTargetWidth(width: number): void {
    this.targetWidth = width > 0 ? width : null
  }

  setVisible(value: boolean): void {
    if (!this.ready) {
      // 未就绪/失败：不进入显示态，避免"空画布挡住站姿"
      if (!value) this.target = 0
      return
    }
    this.target = value ? 1 : 0
  }

  /** 立即隐藏（跨边切换 / 睡姿让位）：不走退出过渡 */
  hideNow(): void {
    this.target = 0
    this.progress = 0
    if (this.root) this.root.visible = false
  }

  update(dt: number): void {
    const root = this.root
    if (!root) return
    this.elapsed += dt
    if (this.progress !== this.target) {
      const step = dt / EDGE_TRANSITION_SECONDS
      this.progress =
        this.progress < this.target
          ? Math.min(this.target, this.progress + step)
          : Math.max(this.target, this.progress - step)
    }
    const eased = smoothstep(this.progress)
    root.visible = this.progress > 0
    if (!root.visible) return

    const scale = EDGE_ENTER_SCALE + (1 - EDGE_ENTER_SCALE) * eased
    // 只给探头加极轻的呼吸起伏；悬挂保持双手稳定抓边
    const breathe =
      this.kind === 'top'
        ? 0
        : Math.sin(this.elapsed * Math.PI * 2 * EDGE_BREATHE_FREQ) * EDGE_BREATHE_AMPLITUDE * eased
    root.scale.setScalar(scale)
    root.position.set(this.baseX, this.baseY + EDGE_ENTER_OFFSET_Y * (1 - eased) + breathe, 0)
    // 耳朵轻微摆动（底部趴睡不启用，保持睡姿安静）
    if (this.kind !== 'bottom') this.earMotion.update(dt)
  }

  /** raycaster 必须已 setFromCamera；返回 null 表示未接管画面 */
  hitTest(raycaster: THREE.Raycaster): boolean | null {
    if (!this.root || this.progress <= 0) return null
    return raycaster.intersectObject(this.root, true).length > 0
  }

  dispose(): void {
    this.disposed = true
    this.token++
    this.earMotion.dispose()
    this.detach()
    if (this.root) disposeObjectResources(this.root)
    this.root = null
    this.model = null
  }

  // ------------------------------------------------------------------ 内部

  private setup(loaded: THREE.Object3D): void {
    // 与站姿一致：卡通兔非金属，压掉偏高的金属度
    loaded.traverse((o) => {
      const mesh = o as THREE.Mesh
      if (!(mesh as THREE.Mesh).isMesh) return
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
      for (const mat of mats) {
        const std = mat as THREE.MeshStandardMaterial
        if (typeof std.metalness === 'number' && std.metalness > 0.1) std.metalness = 0.1
      }
    })

    // 包围盒居中（x/z）、脚底贴 y=0：之后只需用 root.position 做锚点偏移
    const box = new THREE.Box3().setFromObject(loaded)
    const center = box.getCenter(new THREE.Vector3())
    loaded.position.x -= center.x
    loaded.position.z -= center.z
    loaded.position.y -= box.min.y

    // 底部睡姿按目标宽度缩放（与真实睡姿体量一致）；缩放后重新居中贴地
    if (this.targetWidth !== null) {
      const rawWidth = Math.max(0.001, box.max.x - box.min.x)
      loaded.scale.multiplyScalar(this.targetWidth / rawWidth)
      const box2 = new THREE.Box3().setFromObject(loaded)
      const center2 = box2.getCenter(new THREE.Vector3())
      loaded.position.x -= center2.x
      loaded.position.z -= center2.z
      loaded.position.y -= box2.min.y
    }

    const fitted = new THREE.Box3().setFromObject(loaded)
    this.width = Math.max(0.01, fitted.max.x - fitted.min.x)
    this.height = Math.max(0.01, fitted.max.y - fitted.min.y)
    this.zMax = Math.max(0, fitted.max.z)
    this.edgeDepth = this.computeEdgeDepth(loaded, fitted)

    const root = new THREE.Group()
    root.add(loaded)
    this.root = root
    this.model = loaded
    if (this.host) this.host.scene.add(root)
    this.applyAnchor()
    // 耳朵微动绑定（底部趴睡不需要；失败/无耳朵区域时静默不启用）
    if (this.kind !== 'bottom') this.earMotion.attach(loaded, fitted, this.kind)

    this.state = 'ready'
    root.visible = false
    devLog(
      `边缘模型(${this.kind})就绪：宽 ${this.width.toFixed(2)} 高 ${this.height.toFixed(2)}`
    )
  }

  /**
   * 计算贴边侧轮廓带内的最大 z（最靠近相机的深度）：
   * left 取靠近包围盒左边的顶点、right 取右边、bottom 取下边、top 取上边。
   * 顶点世界坐标 = 局部坐标 × mesh.matrixWorld（loaded 已在根坐标系里居中/缩放）。
   * 带内没有顶点时返回 0，调用方回退整只模型的 zMax。
   */
  private computeEdgeDepth(loaded: THREE.Object3D, box: THREE.Box3): number {
    const BAND = 0.05
    const p = new THREE.Vector3()
    let maxZ = 0
    loaded.updateMatrixWorld(true)
    loaded.traverse((object) => {
      const mesh = object as THREE.Mesh
      if (!mesh.isMesh) return
      const pos = mesh.geometry.getAttribute('position')
      if (!pos) return
      const m = mesh.matrixWorld
      for (let i = 0; i < pos.count; i++) {
        p.fromBufferAttribute(pos, i).applyMatrix4(m)
        const inBand =
          this.kind === 'left'
            ? p.x <= box.min.x + BAND
            : this.kind === 'right'
              ? p.x >= box.max.x - BAND
              : this.kind === 'bottom'
                ? p.y <= box.min.y + BAND
                : p.y >= box.max.y - BAND
        if (inBand && p.z > maxZ) maxZ = p.z
      }
    })
    return maxZ
  }

  /** 按 kind + view 计算根组位置（模型在根组内已居中、脚底 y=0） */
  private applyAnchor(): void {
    const view = this.view
    if (!view) {
      this.baseX = 0
      this.baseY = 0
      return
    }
    // 前表面深度处的可见范围：模型自身 z 上限（最靠近相机）+ 少量安全余量。
    // 用 z=0 范围会让前表面（左眼/手/耳）超出画布被裁；用统一的保守深度又会整体内缩太多，
    // 所以按每个模型自己的厚度算——前表面正好贴住屏幕边，后侧切面只内缩几个像素。
    // 贴边侧轮廓的前表面深度；没有采到轮廓顶点时回退整只模型的 zMax。
    // 用边缘轮廓而不是整只模型最前点：切面能更贴近屏幕边，同时该侧轮廓不会被裁。
    const depth = this.edgeDepth > 0 ? this.edgeDepth : this.zMax
    const nearDist = Math.max(0.1, view.cameraDist - depth - EDGE_DEPTH_SAFETY)
    const halfH = nearDist * view.tanHalfFovY
    const halfW = halfH * view.aspect
    const centerY = view.lookY
    if (this.kind === 'left') {
      // 包围盒左边略出屏（EDGE_SIDE_OVERLAP）：切面前边缘贴住/微出屏幕边，后边缘正好落到边内
      this.baseX = -halfW + this.width / 2 - EDGE_SIDE_OVERLAP
      this.baseY = centerY - this.height / 2
    } else if (this.kind === 'right') {
      this.baseX = halfW - this.width / 2 + EDGE_SIDE_OVERLAP
      this.baseY = centerY - this.height / 2
    } else if (this.kind === 'bottom') {
      // 趴睡贴底：水平居中、脚底贴前表面处的画布下边缘
      this.baseX = 0
      this.baseY = centerY - halfH
    } else {
      // 悬挂：水平居中、双手（包围盒上边）贴前表面处的画布上边缘
      this.baseX = 0
      this.baseY = centerY + halfH - this.height
    }
  }
}
