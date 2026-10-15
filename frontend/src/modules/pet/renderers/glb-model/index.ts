/**
 * GLB 模型渲染器（'glb-model'）：加载 Meshy 生成的兔子 GLB 并驱动"整体姿态"。
 *
 * 模型事实（2026-10-15，Meshy 官方重拓扑版 `public/models/meshy-rabbit.glb`）：
 * - **单节点静态网格**：50,000 三角面 / 28,749 顶点 / u16 索引，包含节点级绕 X 轴 +90° 旋转；
 * - **无骨骼、无形状键、无动画**——接口映射只能作用于整体姿态（位移/倾斜/缩放 + 程序化起伏），
 *   姿态数据与合成规则见 `pose.ts`（8 情绪 / 6 状态 / 摸头反应 / 窗口速度感知）；
 * - 1 个 PBR 材质（baseColor + normal + metallicRoughness，均已压为 2K WebP）；
 * - 世界包围盒：x≈[-0.40, 0.33]、y≈[0, 1.08]（脚底在 y=0）、z≈[-0.31, 0.27]。
 *
 * 生命周期（与 ThreeDRenderer 同约定，见 ../three-d/index.ts）：
 * - 模型异步加载（GLTFLoader）；加载完成后按包围盒居中/贴地并挂到"姿态根组 root"；
 * - mount 可重复（先把 root 从场景摘除再挂回）；unmount 停循环、摘画布、root 出场景但**保留资源**；
 * - dispose 彻底释放（几何/材质/贴图 + WebGL 上下文），之后不可再用；加载竞态用 token 化解。
 *
 * 待骨骼版的接入点（用户回 Meshy 做 Smart-Rig 并导出带走路动画的 GLB 后）：
 * - 加载完成后 new THREE.AnimationMixer(gltf.scene)，play 对应 clip（walk/idle/…）；
 * - setState('walking') → 播走路 clip（`AnimationAction.timeScale` 与窗口速度挂钩，等效现在
 *   setLocomotionSpeed 的速度匹配）；setEmotion 可映射为 clip 中的表情轨道或骨骼姿态覆盖；
 * - setMouth 有骨骼/形状键后可驱动下颌/嘴部 morph；本文件其余部分（光照/相机/测速/生命周期）不变。
 */
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import type { Emotion, PetState } from '../../../../shared/protocol'
import type { PetReactionKind, PetRenderer, PetRendererName } from '../types'
import {
  composePose,
  lookAroundYaw,
  petReactionOffsetY,
  LOOK_AROUND_DURATION,
  PET_REACTION_DURATION,
  type GlbChannels
} from './pose'
import { FACE_EX, FACE_EY_DOWN, FACE_ORIGIN, FACE_PROBE } from './face/config'
import { FaceOverlay, type FaceFrame } from './face/overlay'
import { EarsOverlay } from './ears/overlay'

/** dev 态日志（转发到主进程日志，便于无 devtools 验证）；生产构建自动剔除 */
const devLog = (msg: string): void => {
  if (import.meta.env.DEV) console.log(`[pet] ${msg}`)
}

/** 模型文件路径（public/models/；dev = Vite 根路径，生产 = 打包目录相对路径） */
const MODEL_URL = `${import.meta.env.BASE_URL}models/meshy-rabbit.glb`

/**
 * 模型朝向校正（弧度）：Meshy 导出默认面向 +Z（面向观众）；若实测背面朝人则改 Math.PI。
 * 单独的常量便于换模型/换版本时一处调整。
 */
const MODEL_YAW_CORRECTION = 0

/** 相机视场角（度）：数值小 → 透视弱、更"平面可爱"（与 three-d 一致的观感取向） */
const CAMERA_FOV = 30
/**
 * 模型纵向占视锥高度的比例（留出弹跳/惊讶上浮的头部余量）。
 * 实测（208px 容器）：0.83 → 兔子高约 172px（与现役 three-d 兔子 170px 观感一致）。
 */
const CAMERA_FILL_RATIO = 0.83
/**
 * 相机 lookAt 高度 = 模型高 × 此比例。0.5 = 视口中心对准模型中部；
 * 实测（208px 容器）：0.518 时脚底距容器底约 11px（留出 sleeping 下沉 ~9px 不切脚底），
 * 顶部余量约 26px（弹跳/摸头反应上浮 ~21px 不出画）。**比例调大 = 模型在画面里下移**。
 */
const CAMERA_LOOK_AT_RATIO = 0.518

/** 姿态阻尼时间常数（秒）：位移/旋转/缩放分别取值（缩放最慢，显得"体量在变"而非抽搐） */
const TAU_OFFSET = 0.22
const TAU_ROT = 0.28
const TAU_SCALE = 0.35

/** 逐帧 dt 上限（秒）：窗口休眠恢复/长卡顿后避免姿态一次跳变 */
const MAX_DT = 0.05

const DEG2RAD = Math.PI / 180

export class GlbModelRenderer implements PetRenderer {
  readonly name: PetRendererName = 'glb-model'

  // ---- 场景与光 ----
  private readonly scene: THREE.Scene
  private readonly camera: THREE.PerspectiveCamera
  private webgl: THREE.WebGLRenderer | null = null
  private webglFailed = false

  // ---- 模型 ----
  /** 姿态根组（原点 = 模型脚底中心；所有姿态只写这一层） */
  private root: THREE.Group | null = null
  /** 加载的 glTF 场景对象（已居中/贴地；dispose 时释放其资源） */
  private model: THREE.Object3D | null = null
  private loadState: 'idle' | 'loading' | 'ready' | 'failed' = 'idle'
  /** 加载竞态 token（dispose 后到达的加载结果直接丢弃并释放） */
  private loadToken = 0

  // ---- 接口状态（指令先记录；逐帧合成姿态） ----
  private emotion: Emotion = 'neutral'
  private emotionIntensity = 1
  private state: PetState = 'idle'
  /** 阻尼追踪中的通道当前值 */
  private readonly cur: GlbChannels = { offsetY: 0, pitch: 0, yaw: 0, roll: 0, scale: 1 }
  /** 动态起伏相位（弧度，累积；避免长时间运行下 t 数值过大） */
  private phaseMotion = 0
  private phaseQuiver1 = 0
  private phaseQuiver2 = 0
  /** 即时反应：已进行秒数（null = 无反应进行中） */
  private reactionT: number | null = null
  private reactionKind: PetReactionKind | null = null

  // ---- 生命周期 ----
  private container: HTMLElement | null = null
  private resizeObserver: ResizeObserver | null = null
  private rafId: number | null = null
  private lastTs: number | null = null
  private disposed = false
  /** 窗口移动测速（与 three-d 同款：screenX/screenY 差分 + 指数平滑） */
  private lastScreenPos = { x: 0, y: 0, ts: -1 }
  private moveSpeedSmooth = 0

  // ---- SVG 表情叠加层（内部实现细节；PetRenderer 接口不变） ----
  /** 叠在画布之上的 2D 表情层（眨眼/情绪脸；跟随头姿，见 face/overlay.ts） */
  private readonly face = new FaceOverlay()
  /** 每帧复用的脸坐标系投影结果（FaceFrame 字段就地更新，避免逐帧分配） */
  private readonly faceFrame: FaceFrame = { ox: 0, oy: 0, ax: 1, ay: 0, bx: 0, by: 1 }
  /** 投影用的三个屏幕坐标缓冲 */
  private readonly faceScreen = { o: { x: 0, y: 0 }, x: { x: 0, y: 0 }, y: { x: 0, y: 0 } }

  // ---- 耳朵形变层（内部实现细节；PetRenderer 接口不变） ----
  /** 顶点级"耳骨"：程序化微动原耳顶点（挂在模型几何上；见 ears/overlay.ts） */
  private readonly ears = new EarsOverlay()

  constructor() {
    this.scene = new THREE.Scene()
    this.camera = new THREE.PerspectiveCamera(CAMERA_FOV, 1, 0.05, 50)
    this.camera.position.set(0, 0.55, 2.6)
    this.camera.lookAt(0, 0.54, 0)

    // 柔和光照（参考 three-d 的 fluffy 装配：大面积漫射为主 + 温柔主光/补光，低对比无硬阴影）。
    // 强度按"正面照度 ≈ π"配平（three 漫反射含 1/π 因子）：白毛贴图能拉到干净的白而不冲淡颜色。
    // 实测对照（lt-A/B/C/D 档位实验）：照度 3.8 时腮红被冲淡，本档（1.7+0.95+0.45≈π）颜色最饱满。
    const ambient = new THREE.AmbientLight(0xfffbf5, 1.7)
    const hemi = new THREE.HemisphereLight(0xfff8ef, 0xe8e2da, 0.95)
    const key = new THREE.DirectionalLight(0xfff3e4, 0.45)
    key.position.set(1.8, 3.2, 2.8)
    const fill = new THREE.DirectionalLight(0xf4f2ff, 0.2)
    fill.position.set(-2.4, 1.0, 1.6)
    this.scene.add(ambient, hemi, key, fill)
  }

  // ------------------------------------------------------------------ 生命周期

  mount(container: HTMLElement): void {
    if (this.disposed) return
    this.unmount()
    this.container = container

    // ① 触发模型加载（一次；失败保持空容器并告警）
    if (this.loadState === 'idle') this.startLoad()
    // ② 已就绪：把姿态根组挂回场景（unmount 时摘除但保留资源）
    if (this.loadState === 'ready' && this.root && this.root.parent !== this.scene) {
      this.scene.add(this.root)
    }

    // ③ WebGL 上下文（懒创建 + 复用；失败则保持空容器）
    // SVG 表情层的 stage（相对定位包装层）先建好：画布与表情 SVG 都挂在它里面，
    // 这样绝对定位的 SVG 有可靠基准，且不依赖外部容器的 position 样式
    const stage = this.face.attach(container)
    if (!this.webgl && !this.webglFailed) {
      try {
        this.webgl = new THREE.WebGLRenderer({
          alpha: true, // 透明背景（桌面宠物窗口）
          antialias: true,
          powerPreference: 'default'
        })
        this.webgl.setClearAlpha(0)
        this.webgl.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
        // 胶片色调映射（ACES）：高光柔性滚降、颜色更接近原型的柔和饱和感；
        // 曝光 1.2 为实测档（0.9 偏灰、1.5 绿色转黄/腮红淡；见 shots/hi-B-* 实验）
        this.webgl.toneMapping = THREE.ACESFilmicToneMapping
        this.webgl.toneMappingExposure = 1.2
        this.webgl.domElement.addEventListener('webglcontextlost', (e) => {
          e.preventDefault()
          if (!this.disposed) devLog('renderer(glb-model) WebGL 上下文丢失（等待恢复）')
        })
        devLog('renderer(glb-model) WebGL 上下文已创建')
      } catch (err) {
        this.webglFailed = true
        console.warn('[pet] glb-model WebGL 初始化失败（保持空容器）：', err)
      }
    }
    if (this.webgl) {
      const canvas = this.webgl.domElement
      canvas.style.display = 'block'
      canvas.style.width = '100%'
      canvas.style.height = '100%'
      // 插到 SVG 之前（DOM 层序：canvas 在下、表情层在上）
      stage.insertBefore(canvas, stage.firstChild)
      this.applySize()
    }

    // ④ 容器尺寸自适应
    this.resizeObserver = new ResizeObserver(() => this.applySize())
    this.resizeObserver.observe(container)

    this.renderOnce()
    this.lastTs = null
    this.rafId = requestAnimationFrame(this.tick)
    devLog(`renderer(${this.name}) mounted（loadState=${this.loadState}）`)
  }

  unmount(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId)
      this.rafId = null
    }
    this.resizeObserver?.disconnect()
    this.resizeObserver = null
    // root 出场景但保留（资源可复用，再 mount 时挂回）
    if (this.root && this.root.parent === this.scene) this.scene.remove(this.root)
    this.webgl?.domElement.remove()
    this.face.detach() // 移除表情层（stage+SVG；情绪/眨眼状态保留）
    this.container = null
    this.lastTs = null
  }

  dispose(): void {
    this.unmount()
    this.disposed = true // 先置位：加载竞态回调与 contextlost 监听据此静默
    this.loadToken++ // 使在途加载回调失效
    this.face.dispose()
    this.disposeModelResources()
    if (this.webgl) {
      // 显式丢弃 WebGL 上下文（Chromium 有活跃上下文上限；HMR 反复重建防累积）
      try {
        this.webgl.dispose()
        this.webgl.forceContextLoss()
      } catch (err) {
        console.warn('[pet] glb-model 释放 WebGL 上下文异常：', err)
      }
      this.webgl = null
    }
    devLog(`renderer(${this.name}) disposed`)
  }

  // ------------------------------------------------------------------ 指令

  setEmotion(emotion: string, intensity = 1): void {
    // 白名单外的值回退 neutral（协议保证不会出现，防御性处理）
    this.emotion = EMOTIONS_SET.has(emotion) ? (emotion as Emotion) : 'neutral'
    this.emotionIntensity = Math.min(1, Math.max(0, intensity))
    // 同步到 SVG 表情层（脸部表情；与姿态层同一份情绪状态）
    this.face.setEmotion(this.emotion, this.emotionIntensity)
    // 同步到耳朵形变层（耳态；与表情层同一份情绪状态）
    this.ears.setEmotion(this.emotion, this.emotionIntensity)
    devLog(`emotion -> ${emotion} (intensity=${intensity})`)
  }

  setState(state: PetState): void {
    this.state = state
    // 同步到 SVG 表情层（sleeping 时半合眼 + Zzz，见 face/config.ts）
    this.face.setState(state)
    // 同步到耳朵形变层（sleeping 微趴等，见 ears/config.ts）
    this.ears.setState(state)
    devLog(`state -> ${state}`)
  }

  /**
   * 口型开合度 → **当前模型无嘴部件，no-op**（保持接口契约不抛错）。
   * 说话状态由 setState('speaking') 的轻点头表达；待骨骼/形状键版模型到位后，
   * 在此驱动下颌骨骼或 morph 权重（见文件头"待骨骼版的接入点"）。
   */
  setMouth(_level: number): void {
    /* no-op：静态网格无嘴部件 */
  }

  playReaction(kind: PetReactionKind): void {
    // 可重入：重复触发重置进度
    this.reactionKind = kind
    this.reactionT = 0
    devLog(`reaction -> ${kind}`)
  }

  // ------------------------------------------------------------------ 模型加载

  private startLoad(): void {
    this.loadState = 'loading'
    const token = ++this.loadToken
    const loader = new GLTFLoader()
    devLog(`renderer(glb-model) 开始加载模型：${MODEL_URL}`)
    loader.load(
      MODEL_URL,
      (gltf) => {
        // 竞态：已 dispose（或又触发了新加载）→ 释放并丢弃
        if (this.disposed || token !== this.loadToken) {
          disposeObjectResources(gltf.scene)
          return
        }
        this.setupModel(gltf.scene)
      },
      undefined,
      (err) => {
        if (this.disposed || token !== this.loadToken) return
        this.loadState = 'failed'
        console.warn('[pet] glb-model 模型加载失败（保持空容器）：', MODEL_URL, err)
      }
    )
  }

  /** 加载完成：材质微调 → 包围盒居中/贴地 → 建姿态根组 → 相机适配 → 挂耳朵形变层 */
  private setupModel(loaded: THREE.Object3D): void {
    // ① 材质微调：卡通兔是非金属，若烘焙的 metallic 偏高则压到 0.1 以下
    //    （低金属度 + 环境光为主的光照下，避免金属反射导致的"发黑/发灰"）
    loaded.traverse((o) => {
      const mesh = o as THREE.Mesh
      if (!(mesh as THREE.Mesh).isMesh) return
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
      for (const mat of mats) {
        const std = mat as THREE.MeshStandardMaterial
        if (typeof std.metalness === 'number' && std.metalness > 0.1) std.metalness = 0.1
      }
    })

    // ② 包围盒：x/z 居中、脚底贴 y=0（模型自带绕 X 轴旋转，Box3 已含全部节点变换）
    const box = new THREE.Box3().setFromObject(loaded)
    const center = box.getCenter(new THREE.Vector3())
    loaded.position.x -= center.x
    loaded.position.z -= center.z
    loaded.position.y -= box.min.y
    if (MODEL_YAW_CORRECTION !== 0) loaded.rotation.y += MODEL_YAW_CORRECTION

    // ③ 姿态根组（原点 = 脚底中心；缩放/倾斜围绕脚底，弹跳 = 抬升 root.position.y）
    const root = new THREE.Group()
    root.add(loaded)
    this.root = root
    this.model = loaded
    if (this.container) this.scene.add(root) // 已挂载才入场景（未挂载时 mount 时挂回）

    // ④ 相机按模型高度适配（保持透视弱、模型占视锥 CAMERA_FILL_RATIO 的构图）
    const height = Math.max(0.1, box.max.y - box.min.y)
    const frustumH = height / CAMERA_FILL_RATIO
    const dist = frustumH / (2 * Math.tan((CAMERA_FOV * DEG2RAD) / 2))
    const lookY = height * CAMERA_LOOK_AT_RATIO
    this.camera.position.set(0, lookY, dist)
    this.camera.lookAt(0, lookY, 0)

    // ⑤ 耳朵形变层：收集耳朵顶点并绑定几何（顶点级微动；见 ears/config.ts）
    let earMesh: THREE.Mesh | null = null
    loaded.traverse((o) => {
      const mesh = o as THREE.Mesh
      if (!earMesh && (mesh as THREE.Mesh).isMesh) earMesh = mesh
    })
    if (earMesh) {
      const picked = this.ears.attach(root, earMesh)
      devLog(`renderer(glb-model) 耳朵绑定：L ${picked.L} 顶点 / R ${picked.R} 顶点（重叠 ${picked.overlap}）`)
    }

    this.loadState = 'ready'
    devLog(
      `renderer(glb-model) 模型就绪：高 ${height.toFixed(2)}，相机距离 ${dist.toFixed(2)}，` +
        `三角面 ${countTriangles(loaded)}`
    )
    this.renderOnce()
  }

  /** 释放模型资源（几何/材质/贴图，去重后逐一 dispose） */
  private disposeModelResources(): void {
    if (this.root && this.root.parent === this.scene) this.scene.remove(this.root)
    // 耳朵变形层先解绑定（不持有独立资源）；顶点随几何一起释放
    this.ears.dispose()
    if (this.root) disposeObjectResources(this.root)
    this.root = null
    this.model = null
    if (this.loadState === 'ready') this.loadState = 'idle'
  }

  // ------------------------------------------------------------------ 渲染循环

  private readonly tick = (ts: number): void => {
    this.rafId = requestAnimationFrame(this.tick)
    if (this.lastTs === null) {
      this.lastTs = ts
      this.measureMoveSpeed(ts)
      return
    }
    const dt = Math.min(MAX_DT, (ts - this.lastTs) / 1000)
    this.lastTs = ts
    // 窗口实际移动速度 → 姿态（复用 three-d 的 screenX/screenY 差分做法；
    // 行为引擎移动窗口时渲染进程可直接读出"真实步速"，保持 PetRenderer 接口零改动）
    this.measureMoveSpeed(ts)
    this.updatePose(dt)
    // 耳朵形变层：耳态阻尼/微行为（仅姿态变化时重写耳朵顶点；见 ears/overlay.ts）
    this.ears.update(dt)
    this.renderOnce()
    // SVG 表情层跟随（在渲染后投影：此时场景/相机矩阵已刷新，与刚画出的画面完全对齐）
    this.updateFace(dt)
  }

  /** 姿态合成与写入（静态通道阻尼追踪 + 动态起伏 + 反应叠加） */
  private updatePose(dt: number): void {
    const root = this.root
    if (!root) return

    const pose = composePose({
      emotion: this.emotion,
      intensity: this.emotionIntensity,
      state: this.state,
      moveSpeed: this.moveSpeedSmooth
    })

    // ---- 静态通道：指数阻尼追踪（分通道不同时间常数） ----
    const kPos = 1 - Math.exp(-dt / TAU_OFFSET)
    const kRot = 1 - Math.exp(-dt / TAU_ROT)
    const kScale = 1 - Math.exp(-dt / TAU_SCALE)
    this.cur.offsetY += (pose.channels.offsetY - this.cur.offsetY) * kPos
    this.cur.pitch += (pose.channels.pitch - this.cur.pitch) * kRot
    this.cur.yaw += (pose.channels.yaw - this.cur.yaw) * kRot
    this.cur.roll += (pose.channels.roll - this.cur.roll) * kRot
    this.cur.scale += (pose.channels.scale - this.cur.scale) * kScale

    // ---- 动态起伏（同一时刻只播一种；相位累积） ----
    this.phaseMotion += dt * pose.motion.freq * Math.PI * 2
    let motionOffsetY = 0
    let motionPitch = 0
    let motionRoll = 0
    let breathScale = 1
    const m = pose.motion
    if (m.kind === 'bounce') {
      // |sin| 半波：落地为 0、弹起为峰（连续但不穿地）
      motionOffsetY = m.amp * Math.abs(Math.sin(this.phaseMotion))
    } else if (m.kind === 'breathe') {
      motionOffsetY = m.amp * Math.sin(this.phaseMotion)
      breathScale = 1 + 0.005 * Math.sin(this.phaseMotion) // 呼吸伴随极轻微胀缩
    } else if (m.kind === 'nod') {
      motionPitch = m.amp * Math.sin(this.phaseMotion)
    } else if (m.kind === 'sway') {
      motionRoll = m.amp * Math.sin(this.phaseMotion)
    }

    // ---- 高频微颤（angry：两条不相干频率叠加，避免机械正弦感） ----
    let quiverPitch = 0
    if (pose.quiver > 0.001) {
      this.phaseQuiver1 += dt * 2 * Math.PI * 6.1
      this.phaseQuiver2 += dt * 2 * Math.PI * 9.7
      quiverPitch = pose.quiver * (0.62 * Math.sin(this.phaseQuiver1) + 0.38 * Math.sin(this.phaseQuiver2))
    }

    // ---- 即时反应（独立时间轴；pet = 弹跳，look_around = 左右转头） ----
    let reactionOffsetY = 0
    let reactionYaw = 0
    if (this.reactionT !== null && this.reactionKind !== null) {
      this.reactionT += dt
      if (this.reactionKind === 'pet') {
        reactionOffsetY = petReactionOffsetY(this.reactionT)
        if (this.reactionT >= PET_REACTION_DURATION) this.reactionT = null
      } else {
        reactionYaw = lookAroundYaw(this.reactionT)
        if (this.reactionT >= LOOK_AROUND_DURATION) this.reactionT = null
      }
    }

    // ---- 写入根组（缩放围绕脚底；反应叠加在阻尼姿态之上） ----
    root.position.y = this.cur.offsetY + motionOffsetY + reactionOffsetY
    root.rotation.set(this.cur.pitch + motionPitch + quiverPitch, this.cur.yaw + reactionYaw, this.cur.roll + motionRoll)
    root.scale.setScalar(this.cur.scale * breathScale)
  }

  /**
   * 测窗口移动速度（px/s，指数平滑）：与 three-d 同款做法——
   * 行为引擎按 distance/duration_ms 缓动移动窗口（electron/window/move.ts），
   * 渲染进程直接读 screenX/screenY 差分即可获得"真实步速"。
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

  /** 相机纵横比/画布尺寸跟随容器（0 尺寸时用 208 兜底——与真机 pet-view 同尺寸） */
  private applySize(): void {
    if (!this.webgl || !this.container) return
    const w = this.container.clientWidth || 208
    const h = this.container.clientHeight || 208
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
    this.webgl.setSize(w, h, false)
  }

  private renderOnce(): void {
    if (this.webgl) this.webgl.render(this.scene, this.camera)
  }

  // ------------------------------------------------------------------ SVG 表情层跟随

  /**
   * 更新 SVG 表情层：把脸坐标系（原点=两眼中点，见 face/config.ts）的
   * O、O+ex×probe、O+eyDown×probe 三点投影到屏幕，得到"世界单位 → 屏幕 px"的局部仿射，
   * 交给叠加层写根组矩阵（整层随头部/整体姿态平移、旋转、缩放）。
   * 在 renderOnce 之后调用，保证与当前帧画面一致。
   */
  private updateFace(dt: number): void {
    const root = this.root
    if (!root || !this.container || this.loadState !== 'ready') {
      this.face.update(dt, null) // 模型未就绪：隐藏叠加层（眨眼计时照常推进，无副作用）
      return
    }
    // 矩阵新鲜化（正常路径下 renderOnce 已刷新；WebGL 不可用时也能正确跟随）
    root.updateMatrixWorld()
    this.camera.updateMatrixWorld()
    this.camera.matrixWorldInverse.copy(this.camera.matrixWorld).invert()

    const screen = this.faceScreen
    this.projectScreen(_faceTmpA.copy(FACE_ORIGIN_V).applyMatrix4(root.matrixWorld), screen.o)
    this.projectScreen(
      _faceTmpB
        .copy(FACE_EX_V)
        .multiplyScalar(FACE_PROBE)
        .add(FACE_ORIGIN_V)
        .applyMatrix4(root.matrixWorld),
      screen.x
    )
    this.projectScreen(
      _faceTmpC
        .copy(FACE_EY_V)
        .multiplyScalar(FACE_PROBE)
        .add(FACE_ORIGIN_V)
        .applyMatrix4(root.matrixWorld),
      screen.y
    )

    const f = this.faceFrame
    f.ox = screen.o.x
    f.oy = screen.o.y
    f.ax = (screen.x.x - screen.o.x) / FACE_PROBE
    f.ay = (screen.x.y - screen.o.y) / FACE_PROBE
    f.bx = (screen.y.x - screen.o.x) / FACE_PROBE
    f.by = (screen.y.y - screen.o.y) / FACE_PROBE
    this.face.update(dt, f)
  }

  /** 世界坐标 → 容器内屏幕坐标（px，左上原点；与 applySize 的兜底尺寸一致） */
  private projectScreen(world: THREE.Vector3, out: { x: number; y: number }): void {
    const w = this.container ? this.container.clientWidth || 208 : 208
    const h = this.container ? this.container.clientHeight || 208 : 208
    // Vector3.applyMatrix4 对投影矩阵会自动做透视除法（与 Vector3.project 等价）
    const v = world.applyMatrix4(this.camera.matrixWorldInverse).applyMatrix4(this.camera.projectionMatrix)
    out.x = (v.x * 0.5 + 0.5) * w
    out.y = (1 - (v.y * 0.5 + 0.5)) * h
  }
}

// ------------------------------------------------------------------ 工具函数

/** 脸坐标系基础本地向量（从 face/config 构造一次；每帧只读，投影时 copy 到临时向量） */
const FACE_ORIGIN_V = new THREE.Vector3(FACE_ORIGIN[0], FACE_ORIGIN[1], FACE_ORIGIN[2])
const FACE_EX_V = new THREE.Vector3(FACE_EX[0], FACE_EX[1], FACE_EX[2])
const FACE_EY_V = new THREE.Vector3(FACE_EY_DOWN[0], FACE_EY_DOWN[1], FACE_EY_DOWN[2])
/** 投影临时向量（模块级复用；单线程内"写完即用、用完即弃"，多实例并存也安全） */
const _faceTmpA = new THREE.Vector3()
const _faceTmpB = new THREE.Vector3()
const _faceTmpC = new THREE.Vector3()

/** 情绪白名单集合（防御性回退用；与 protocol 的 EMOTION_VALUES 对齐） */
const EMOTIONS_SET: ReadonlySet<string> = new Set([
  'neutral',
  'happy',
  'sad',
  'angry',
  'surprised',
  'shy',
  'thinking',
  'sleepy'
])

/** 统计网格三角面数（日志用） */
function countTriangles(obj: THREE.Object3D): number {
  let tris = 0
  obj.traverse((o) => {
    const mesh = o as THREE.Mesh
    if (!(mesh as THREE.Mesh).isMesh) return
    const geo = mesh.geometry as THREE.BufferGeometry
    if (geo.index) tris += geo.index.count / 3
    else if (geo.attributes.position) tris += geo.attributes.position.count / 3
  })
  return Math.round(tris)
}

/** 释放一棵对象树中的全部几何/材质/贴图（Set 去重，避免共享资源重复释放） */
function disposeObjectResources(obj: THREE.Object3D): void {
  const geometries = new Set<THREE.BufferGeometry>()
  const materials = new Set<THREE.Material>()
  const textures = new Set<THREE.Texture>()
  obj.traverse((o) => {
    const mesh = o as THREE.Mesh
    if (!(mesh as THREE.Mesh).isMesh) return
    if (mesh.geometry) geometries.add(mesh.geometry)
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
    for (const mat of mats) {
      if (!mat) continue
      materials.add(mat)
      // 收集材质上的所有贴图（map/normalMap/roughnessMap/…；遍历字段比逐个列举更耐扩展）
      for (const value of Object.values(mat)) {
        if (value && (value as THREE.Texture).isTexture) textures.add(value as THREE.Texture)
      }
    }
  })
  geometries.forEach((g) => g.dispose())
  materials.forEach((m) => m.dispose())
  textures.forEach((t) => t.dispose())
}
