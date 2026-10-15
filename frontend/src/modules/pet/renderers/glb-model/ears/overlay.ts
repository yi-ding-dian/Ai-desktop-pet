/**
 * 耳朵形变叠加层（glb-model 渲染器内部实现细节；PetRenderer 接口零改动）。
 *
 * 目标（v1 定稿）：**耳朵"活体微动"**——常驻轻晃（±2°）、随机小耳抖（~4°）、情绪间
 * 几度级的微姿态差（全表 ≤ 9°）。不追求"耳朵表情"（大幅垂耳方案已按用户反馈取消），
 * 只让耳朵显得"活着"。
 *
 * 原理：**顶点级分布式角度旋转**——把"耳朵顶点集合"按沿耳轴的归一化位置
 * （t：0 = 耳根、1 = 耳尖）赋"角度分布系数"，每个顶点**围绕铰链轴旋转的角度随 t 平滑渐变**
 * （耳根处恒 0——"耳根绝对不裂"；中段起渐增，耳尖拿满角），叠加"二级卷曲"的额外角度分布
 * （后段更多）。相比"整耳刚性旋转 + 权重线性混合"，分布式旋转没有把顶点往"弦"上拉的
 * 收缩效应（过渡带不会缩腰/折痕），是软体弯曲的标准做法；微动量级下更是无感。
 *
 * 每帧流程（由渲染器 tick 调用，与 face 层同帧）：
 *   目标耳态（情绪×状态×强度）→ 指数阻尼过渡（TAU_EAR，缓缓飘过去）→ 叠加微行为
 *   （常驻轻晃 / happy 轻快摆动 / 随机耳抖）→ **仅当姿态相对上一帧确有变化时**才重写
 *   耳朵顶点的 position attribute（静止帧零计算）。
 *
 * 挂载方式：attach(root, mesh) 时从几何里**一次性**收集耳朵顶点（预存索引 + 角度分布
 * 系数 + 原始位置 + 左右归属），并把标定参数（root 局部坐标）换算到 mesh 几何的本地空间；
 * 之后每条顶点只做"读原始位置 → 两次轴角旋转 → 写回"。模型其他部分（身体/脸）不动。
 *
 * 法线处理（权衡）：不重算法线。微动幅度下（每顶点旋转角 ≤ 9°、位移 ≤ 数毫米）
 * 法线按原姿态近似的光照误差远低于可见阈值。
 */
import * as THREE from 'three'
import type { Emotion, PetState } from '../../../../../shared/protocol'
import {
  EAR_L,
  EAR_R,
  EAR_HAPPY_SWAY,
  EAR_INTENSITY,
  EAR_PICK,
  EAR_SLEEP_SWAY,
  EAR_SWAY,
  EAR_TWITCH,
  EAR_WEIGHT,
  EMOTION_EAR_POSES,
  HAPPY_SWAY_EMOTIONS,
  SLEEP_SWAY_EMOTIONS,
  STATE_EAR_POSES,
  TAU_EAR,
  type EarPose,
  type EarSpec
} from './config'

const DEG = Math.PI / 180
const clamp01 = (v: number): number => Math.min(1, Math.max(0, v))

/** smoothstep：t 从 a 到 b 平滑过渡 0→1（t≤a 为 0，t≥b 为 1） */
function smoothstep(t: number, a: number, b: number): number {
  const x = clamp01((t - a) / (b - a))
  return x * x * (3 - 2 * x)
}

/** 耳朵标定（root 局部）→ 换算到 mesh 本地空间的运行时数据 */
interface EarBinding {
  /** 耳根枢轴（mesh 本地空间） */
  pivot: THREE.Vector3
  /** 原始耳轴（单位向量，mesh 本地空间；指向耳尖） */
  u0: THREE.Vector3
  /** 耳长（pivot→tip 距离） */
  len: number
  /**
   * 一级旋转铰链轴（mesh 本地空间）：= normalize(耳轴 × "垂下方向(fall)")，
   * 绕它正转 = 耳尖朝"外下"倒下（roll 正方向）；负转 = 向内上立起。
   * 符号已统一（对任何初始姿态的耳朵，"正 = 向外倒"语义一致）。
   */
  axisR: THREE.Vector3
  /**
   * 二级（俯仰）铰链轴（mesh 本地空间）：垂直于耳轴与 axisR，
   * 绕它正转 = 耳尖向前（pitch 正方向）；符号已统一。
   */
  axisP: THREE.Vector3
}

/** 顶点收集结果（供 overlay 与离线染色实验共用） */
export interface EarPickResult {
  /** 判定为耳朵的顶点索引（升序；与 rest/w1/w2/side 逐项对齐） */
  indices: number[]
  /** 归一化轴位置 t/L（0 耳根 → 1 耳尖；可 <0 或 >1，分布函数会夹紧） */
  tNorm: number[]
  /** 顶点归属：0 = 左耳、1 = 右耳 */
  side: number[]
  /** 各耳命中数 */
  count: { L: number; R: number; overlap: number }
}

/** mesh 本地空间中的单耳判定参数 */
export interface EarBindSpace extends EarBinding {
  radius: number
}

/** root 局部 → mesh 本地：用 root 与 mesh 的世界矩阵算出并取逆（一次性） */
export function computeMeshLocalInverse(root: THREE.Object3D, mesh: THREE.Object3D): THREE.Matrix4 {
  root.updateMatrixWorld(true)
  const local = new THREE.Matrix4().copy(root.matrixWorld).invert().multiply(mesh.matrixWorld)
  return local.invert()
}

/**
 * 由 root 局部的标定（EarSpec）+ 变换逆矩阵，构造 mesh 本地空间的判定/旋转参数。
 * @param outwardSign 该耳的"外侧"在 root X 轴上的符号（左耳 −1、右耳 +1）
 */
export function bindEarSpace(spec: EarSpec, invLocal: THREE.Matrix4, outwardSign: number): EarBindSpace {
  const pivot = new THREE.Vector3(spec.pivot[0], spec.pivot[1], spec.pivot[2]).applyMatrix4(invLocal)
  const tip = new THREE.Vector3(spec.tip[0], spec.tip[1], spec.tip[2]).applyMatrix4(invLocal)
  const u0 = new THREE.Vector3().subVectors(tip, pivot)
  const len = u0.length()
  u0.normalize()
  // root 空间的基向量/方向 → mesh 空间（方向向量只取旋转部分；mesh 本地空间带节点级 +90° 旋转）
  const rot = new THREE.Matrix4().extractRotation(invLocal)
  const ex = new THREE.Vector3(1, 0, 0).applyMatrix4(rot)
  const ez = new THREE.Vector3(0, 0, 1).applyMatrix4(rot)
  const fall = new THREE.Vector3(spec.fall[0], spec.fall[1], spec.fall[2]).applyMatrix4(rot).normalize()

  // 一级铰链轴 = 耳轴 × 垂下方向；再统一符号（正转 = 耳尖向外）
  const axisR = new THREE.Vector3().crossVectors(u0, fall)
  if (axisR.lengthSq() < 1e-10) axisR.set(0, 0, 1).cross(u0) // 退化保护（耳轴≈fall 方向）
  axisR.normalize()
  const tangentR = new THREE.Vector3().crossVectors(axisR, u0)
  if (tangentR.dot(ex) * outwardSign < 0) axisR.negate()

  // 二级（俯仰）轴 = 垂直于耳轴与一级轴；统一符号（正转 = 耳尖向前 = root +Z）
  const axisP = new THREE.Vector3().crossVectors(u0, axisR)
  if (axisP.lengthSq() < 1e-10) axisP.set(1, 0, 0)
  axisP.normalize()
  const tangentP = new THREE.Vector3().crossVectors(axisP, u0)
  if (tangentP.dot(ez) < 0) axisP.negate()

  return { pivot, u0, len, radius: spec.radius, axisR, axisP }
}

/**
 * 收集耳朵顶点（对每顶点测"到耳轴的垂距 + 沿轴投影范围"，胶囊包络判定）。
 * 同一顶点被两耳同时判中（理论重叠 ~0）时取垂距更近的一侧。
 */
export function collectEarVertices(
  geometry: THREE.BufferGeometry,
  earL: EarBindSpace,
  earR: EarBindSpace
): EarPickResult {
  const pos = geometry.getAttribute('position') as THREE.BufferAttribute
  const count = pos.count
  const out: EarPickResult = { indices: [], tNorm: [], side: [], count: { L: 0, R: 0, overlap: 0 } }

  for (let i = 0; i < count; i++) {
    const px = pos.getX(i)
    const py = pos.getY(i)
    const pz = pos.getZ(i)
    let best = -1 // 0=L 1=R
    let bestD = Infinity
    let bestT = 0
    let hit = 0

    for (let e = 0; e < 2; e++) {
      const ear = e === 0 ? earL : earR
      const rx = px - ear.pivot.x
      const ry = py - ear.pivot.y
      const rz = pz - ear.pivot.z
      const s = rx * ear.u0.x + ry * ear.u0.y + rz * ear.u0.z
      if (s < EAR_PICK.sMin || s > ear.len + EAR_PICK.sMax) continue
      const ox = rx - s * ear.u0.x
      const oy = ry - s * ear.u0.y
      const oz = rz - s * ear.u0.z
      const d = Math.sqrt(ox * ox + oy * oy + oz * oz)
      if (d >= ear.radius) continue
      hit++
      out.count[e === 0 ? 'L' : 'R']++
      if (d < bestD) {
        bestD = d
        best = e
        bestT = s / ear.len
      }
    }

    if (best < 0) continue
    if (hit > 1) out.count.overlap++
    out.indices.push(i)
    out.tNorm.push(bestT)
    out.side.push(best)
  }

  return out
}

/** 阻尼过渡中的耳态（弧度制） */
export interface EarPoseRad {
  roll: number
  pitch: number
  curl: number
}

/** 目标耳态（度 → 弧度 + 强度缩放） */
function toRad(p: EarPose, k: number): EarPoseRad {
  return { roll: p.roll * DEG * k, pitch: p.pitch * DEG * k, curl: p.curl * k }
}

function lerpRad(cur: EarPoseRad, target: EarPoseRad, k: number): void {
  cur.roll += (target.roll - cur.roll) * k
  cur.pitch += (target.pitch - cur.pitch) * k
  cur.curl += (target.curl - cur.curl) * k
}

/** 姿态差异阈值（弧度）：小于它视为"已到位"（吸附，让静止帧真正静止） */
const SNAP_EPS = 0.0005

function snap(cur: EarPoseRad, target: EarPoseRad): void {
  if (Math.abs(target.roll - cur.roll) < SNAP_EPS) cur.roll = target.roll
  if (Math.abs(target.pitch - cur.pitch) < SNAP_EPS) cur.pitch = target.pitch
  if (Math.abs(target.curl - cur.curl) < SNAP_EPS) cur.curl = target.curl
}

/** 微行为通道（弧度；叠加在阻尼后的基态上，参与"变化检测"） */
interface MicroMotion {
  rollL: number
  rollR: number
}

export class EarsOverlay {
  // ---- 绑定数据（attach 时一次性构建） ----
  private geometry: THREE.BufferGeometry | null = null
  private position: THREE.BufferAttribute | null = null
  /** 耳朵顶点索引（升序） */
  private indices: Uint32Array | null = null
  /** 每顶点：一级角度分布系数 g1 / 二级（卷曲）角度分布系数 g2 */
  private g1: Float32Array | null = null
  private g2: Float32Array | null = null
  /** 每顶点归属（0=L 1=R） */
  private side: Uint8Array | null = null
  /** 每顶点：原始位置（mesh 本地；与 indices 对齐的扁平 xyz） */
  private rest: Float32Array | null = null
  /**
   * 顶点写回的底层数组 + 寻址参数（本模型的 position 是**交错缓冲属性**
   * InterleavedBufferAttribute——position/normal/uv 共用一个 buffer、每顶点 8 floats；
   * 直接操作底层数组可避免逐顶点 setXYZ 的调用开销，也不会碰到 normal/uv 分量）。
   */
  private writeArr: Float32Array | null = null
  private writeStride = 3
  private writeOffset = 0
  /** 两耳绑定 */
  private earL: EarBinding | null = null
  private earR: EarBinding | null = null

  // ---- 接口状态 ----
  private emotion: Emotion = 'neutral'
  private intensity = 1
  private state: PetState = 'idle'

  // ---- 动画状态 ----
  /** 当前（阻尼中）耳态（弧度） */
  private readonly cur: { L: EarPoseRad; R: EarPoseRad } = {
    L: { roll: 0, pitch: 0, curl: 0 },
    R: { roll: 0, pitch: 0, curl: 0 }
  }
  /** 常驻轻晃相位 */
  private swayPhase = 0
  /** 耳抖：当前进行中的已播时间（null = 无）与目标耳 */
  private twitchT: number | null = null
  private twitchSide: 0 | 1 = 0
  /** 距下次耳抖的秒数（-1 = 尚未初始化，首帧随机） */
  private twitchNext = -1
  /** 上次提交的"姿态签名"（标量组；相同则跳过顶点重写） */
  private lastSig: number[] | null = null

  /**
   * 挂载：从几何收集耳朵顶点并建立绑定；随后立即落位到当前目标耳态
   * （避免挂载瞬间从"原始耳态"跳变）。返回收集统计（供渲染器日志）。
   */
  attach(root: THREE.Object3D, mesh: THREE.Mesh): { L: number; R: number; overlap: number } {
    const geometry = mesh.geometry as THREE.BufferGeometry
    const invLocal = computeMeshLocalInverse(root, mesh)
    const earL = bindEarSpace(EAR_L, invLocal, -1)
    const earR = bindEarSpace(EAR_R, invLocal, 1)

    const picked = collectEarVertices(geometry, earL, earR)
    const n = picked.indices.length
    const g1 = new Float32Array(n)
    const g2 = new Float32Array(n)
    const side = new Uint8Array(n)
    const rest = new Float32Array(n * 3)
    const pos = geometry.getAttribute('position') as THREE.BufferAttribute
    for (let k = 0; k < n; k++) {
      const i = picked.indices[k]
      const t = picked.tNorm[k]
      g1[k] = smoothstep(t, EAR_WEIGHT.W1_START, EAR_WEIGHT.W1_END)
      g2[k] = smoothstep(t, EAR_WEIGHT.W2_START, EAR_WEIGHT.W2_END)
      side[k] = picked.side[k]
      rest[k * 3] = pos.getX(i)
      rest[k * 3 + 1] = pos.getY(i)
      rest[k * 3 + 2] = pos.getZ(i)
    }

    this.geometry = geometry
    this.position = pos
    this.indices = new Uint32Array(picked.indices)
    this.g1 = g1
    this.g2 = g2
    this.side = side
    this.rest = rest
    this.earL = earL
    this.earR = earR

    // 顶点写回的目标（普通 BufferAttribute / 交错 InterleavedBufferAttribute 统一寻址）
    const irba = pos as unknown as THREE.InterleavedBufferAttribute
    if ((irba as unknown as { isInterleavedBufferAttribute?: boolean }).isInterleavedBufferAttribute) {
      this.writeArr = irba.data.array as Float32Array
      this.writeStride = irba.data.stride
      this.writeOffset = irba.offset
    } else {
      this.writeArr = pos.array as Float32Array
      this.writeStride = 3
      this.writeOffset = 0
    }

    // 形变可能让耳尖绕枢轴转到原包围球外沿：放宽 boundingSphere（一次即可；
    // 相机/视锥剔除不会误剔，也没有阴影渲染需要重算）
    if (!geometry.boundingSphere) geometry.computeBoundingSphere()
    const bs = geometry.boundingSphere
    if (bs) {
      const grow = (ear: EarBinding): number => bs.center.distanceTo(ear.pivot) + ear.len + 0.05
      bs.radius = Math.max(bs.radius, grow(earL), grow(earR))
    }

    // 位置每帧可能更新 → 声明为动态使用（GL 层上传提示；交错属性设在所属 InterleavedBuffer 上）
    if ((irba as unknown as { isInterleavedBufferAttribute?: boolean }).isInterleavedBufferAttribute) {
      irba.data.setUsage(THREE.DynamicDrawUsage)
    } else {
      pos.setUsage(THREE.DynamicDrawUsage)
    }

    // 立即落位（含首帧微行为相位从 0 开始）
    this.snapToCurrentTarget()
    return picked.count
  }

  /** 卸载：解除绑定（不动几何数据；模型资源由渲染器统一释放） */
  detach(): void {
    this.geometry = null
    this.position = null
    this.indices = null
    this.g1 = null
    this.g2 = null
    this.side = null
    this.rest = null
    this.writeArr = null
    this.earL = null
    this.earR = null
    this.lastSig = null
  }

  /** 彻底释放（本层不持有独立几何/材质，仅解绑定） */
  dispose(): void {
    this.detach()
  }

  // ------------------------------------------------------------------ 指令

  setEmotion(emotion: Emotion, intensity: number): void {
    this.emotion = emotion
    this.intensity = clamp01(intensity)
  }

  setState(state: PetState): void {
    this.state = state
  }

  // ------------------------------------------------------------------ 每帧更新

  /** 每帧更新（渲染器 tick 调用；未挂载时为 no-op）。 */
  update(dt: number): void {
    const bind = this.position
    if (!bind || !this.earL || !this.earR) return

    const pose = getTargetPose(this.emotion, this.intensity, this.state)
    // 指数阻尼过渡
    const k = 1 - Math.exp(-dt / TAU_EAR)
    lerpRad(this.cur.L, pose.L, k)
    lerpRad(this.cur.R, pose.R, k)
    snap(this.cur.L, pose.L)
    snap(this.cur.R, pose.R)

    // ---- 微行为 ----
    const micro = this.updateMicro(dt)

    // 变化检测：所有参与形变的标量都与上一帧相同 → 跳过顶点重写（静止帧零计算）
    const sig = [
      this.cur.L.roll,
      this.cur.L.pitch,
      this.cur.L.curl,
      this.cur.R.roll,
      this.cur.R.pitch,
      this.cur.R.curl,
      micro.rollL,
      micro.rollR
    ]
    const last = this.lastSig
    if (last) {
      let same = true
      for (let i = 0; i < sig.length; i++) {
        if (Math.abs(sig[i] - last[i]) > 1e-6) {
          same = false
          break
        }
      }
      if (same) return
    }
    this.lastSig = sig

    this.applyDeform(micro)
  }

  /**
   * 微行为：常驻轻晃（默认小幅慢摆；happy 反相轻甩、sleepy/sleeping 极缓呼吸摆）+
   * 随机耳抖（规则：非睡眠/拖拽时，每 4–9s 随机挑一耳快速外弹一下）。
   */
  private updateMicro(dt: number): MicroMotion {
    // 摆动相位（频率按情绪/状态切换；相位连续累积，切换时不断裂）
    let freq = EAR_SWAY.freq
    let amp = EAR_SWAY.amp
    let antiPhase = false
    if (HAPPY_SWAY_EMOTIONS.includes(this.emotion)) {
      freq = EAR_HAPPY_SWAY.freq
      amp = EAR_HAPPY_SWAY.amp
      antiPhase = true
    } else if (SLEEP_SWAY_EMOTIONS.includes(this.emotion) || this.state === 'sleeping') {
      freq = EAR_SLEEP_SWAY.freq
      amp = EAR_SLEEP_SWAY.amp
    }
    this.swayPhase += dt * freq * Math.PI * 2
    const sway = amp * Math.sin(this.swayPhase)

    // 耳抖调度：睡眠/拖拽不抖；每 4–9s 随机挑一耳弹一下
    const twitchAllowed = this.state !== 'sleeping' && this.state !== 'dragging'
    if (this.twitchNext < 0) {
      this.twitchNext = EAR_TWITCH.gapMin + Math.random() * (EAR_TWITCH.gapMax - EAR_TWITCH.gapMin)
    }
    if (this.twitchT === null) {
      this.twitchNext -= dt
      if (this.twitchNext <= 0 && twitchAllowed) {
        this.twitchT = 0
        this.twitchSide = Math.random() < 0.5 ? 0 : 1
        this.twitchNext = EAR_TWITCH.gapMin + Math.random() * (EAR_TWITCH.gapMax - EAR_TWITCH.gapMin)
      }
    }
    let twitch = 0
    if (this.twitchT !== null) {
      if (!twitchAllowed) {
        this.twitchT = null // 中途睡着/被拖拽：立即取消
      } else {
        this.twitchT += dt
        const p = this.twitchT / EAR_TWITCH.duration
        if (p >= 1) {
          this.twitchT = null
        } else {
          twitch = EAR_TWITCH.amp * Math.sin(p * Math.PI) // 半波：0→峰→0
        }
      }
    }

    // 组装：轻晃两耳同相（happy 反相）；耳抖只作用于被选中的一耳（向外弹为正）
    const micro: MicroMotion = { rollL: sway, rollR: antiPhase ? -sway : sway }
    if (twitch !== 0) {
      if (this.twitchSide === 0) micro.rollL += twitch
      else micro.rollR += twitch
    }
    return micro
  }

  /** 一步落位到当前目标（attach 时用；跳过阻尼直接应用） */
  private snapToCurrentTarget(): void {
    const pose = getTargetPose(this.emotion, this.intensity, this.state)
    this.cur.L = { ...pose.L }
    this.cur.R = { ...pose.R }
    this.applyDeform({ rollL: 0, rollR: 0 })
  }

  /**
   * 顶点形变（核心）：**分布式角度旋转**——每个顶点绕铰链轴旋转的角度随"沿耳位置 t"
   * 平滑渐变，而不是"整只刚性旋转 + 权重混合"（后者把过渡带顶点往弦上拉，窄过渡带+大角度
   * 时缩腰/折痕）。对每顶点：
   *   θ_roll(t)  = (roll + 微行为)·g1(t) + curl·g2(t)    （绕 axisR：根 0 → 尖满角，卷曲在后段再加）
   *   θ_pitch(t) = pitch·g1(t)                            （绕 axisP：前后俯仰同分布）
   *   v' = P0 + R(axisP, θ_pitch) · R(axisR, θ_roll) · (v − P0)
   * g1/g2 为预存的角度分布系数（smoothstep，见 config.EAR_WEIGHT）。耳根处 θ=0（不裂）；
   * 梯度平缓 → 弯曲呈现连续弧线。
   */
  private applyDeform(micro: MicroMotion): void {
    const w1s = this.g1
    const w2s = this.g2
    const sides = this.side
    const rest = this.rest
    const position = this.position
    const earL = this.earL
    const earR = this.earR
    const arr = this.writeArr
    const stride = this.writeStride
    const woff = this.writeOffset
    const indices = this.indices
    if (!indices || !w1s || !w2s || !sides || !rest || !position || !earL || !earR || !arr) return

    // 每耳的总角（含微行为）
    const rollL = this.cur.L.roll + micro.rollL
    const pitchL = this.cur.L.pitch
    const curlL = this.cur.L.curl
    const rollR = this.cur.R.roll + micro.rollR
    const pitchR = this.cur.R.pitch
    const curlR = this.cur.R.curl

    for (let k = 0; k < indices.length; k++) {
      const o = indices[k] * stride + woff
      const cx = rest[k * 3]
      const cy = rest[k * 3 + 1]
      const cz = rest[k * 3 + 2]
      const isL = sides[k] === 0
      const ear = isL ? earL : earR
      const roll = isL ? rollL : rollR
      const pitch = isL ? pitchL : pitchR
      const curl = isL ? curlL : curlR
      const g1 = w1s[k]
      const g2 = w2s[k]

      const thR = roll * g1 + curl * g2
      const thP = pitch * g1
      if (thR === 0 && thP === 0) {
        arr[o] = cx
        arr[o + 1] = cy
        arr[o + 2] = cz
        continue
      }

      // 相对耳根的向量
      let vx = cx - ear.pivot.x
      let vy = cy - ear.pivot.y
      let vz = cz - ear.pivot.z

      // ---- 绕 axisR 旋转 thR（Rodrigues：v·c + (a×v)·s + a·(a·v)·(1−c)）----
      if (thR !== 0) {
        const a = ear.axisR
        const c = Math.cos(thR)
        const s = Math.sin(thR)
        const dot = a.x * vx + a.y * vy + a.z * vz
        const rx = a.y * vz - a.z * vy
        const ry = a.z * vx - a.x * vz
        const rz = a.x * vy - a.y * vx
        const k1 = dot * (1 - c)
        vx = vx * c + rx * s + a.x * k1
        vy = vy * c + ry * s + a.y * k1
        vz = vz * c + rz * s + a.z * k1
      }

      // ---- 绕 axisP 旋转 thP ----
      if (thP !== 0) {
        const a = ear.axisP
        const c = Math.cos(thP)
        const s = Math.sin(thP)
        const dot = a.x * vx + a.y * vy + a.z * vz
        const rx = a.y * vz - a.z * vy
        const ry = a.z * vx - a.x * vz
        const rz = a.x * vy - a.y * vx
        const k1 = dot * (1 - c)
        vx = vx * c + rx * s + a.x * k1
        vy = vy * c + ry * s + a.y * k1
        vz = vz * c + rz * s + a.z * k1
      }

      arr[o] = ear.pivot.x + vx
      arr[o + 1] = ear.pivot.y + vy
      arr[o + 2] = ear.pivot.z + vz
    }
    position.needsUpdate = true
  }
}

// ------------------------------------------------------------------ 纯函数

/** 求目标耳态（情绪 × 状态 × 强度；弧度制）：状态覆盖优先于情绪；强度缩放旋转角 */
export function getTargetPose(
  emotion: Emotion,
  intensity: number,
  state: PetState
): { L: EarPoseRad; R: EarPoseRad } {
  const base = STATE_EAR_POSES[state] ?? EMOTION_EAR_POSES[emotion] ?? EMOTION_EAR_POSES.neutral
  const k = EAR_INTENSITY.low + (1 - EAR_INTENSITY.low) * clamp01(intensity)
  return { L: toRad(base.L, k), R: toRad(base.R, k) }
}
