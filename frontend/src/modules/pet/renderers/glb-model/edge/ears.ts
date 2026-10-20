/**
 * 边缘动作模型的耳朵微动（2026-10-20）。
 *
 * 背景：悬挂/左探/右探是独立静态 GLB，接管画面后完全静止，观感"死板"。
 * 用户要求"耳朵轻微动一下，像站着那样动的幅度"。
 *
 * 做法：不做精确耳骨标定（三个模型姿态差异大、硬编码 pivot 不通用），而是按
 * **空间权重**选出耳朵区域顶点，绕根组坐标系的 z 轴做 ±1.7° 的正弦微旋转：
 * - 探头（left/right）：模型上部、且远离身体切面一侧 → 罩住两只耳朵，额头权重低；
 * - 悬挂（top）：模型下部、左右两侧 → 罩住垂下的两只耳朵；
 * - 权重从耳根到耳尖 smoothstep 渐变（耳根 0），避免"耳根被撕开"。
 *
 * 实现要点：
 * - 顶点只在 attach 时做一次世界坐标 → 权重筛选，之后每帧只遍历耳朵顶点（~数千）；
 * - pivot/旋转轴一次性换算到 mesh 几何本地空间，逐帧只做读原始位置 → 小角度旋转 → 写回；
 * - 幅度很小（耳尖约 2px），不重算法线（与站姿耳朵层的处理一致）。
 */
import * as THREE from 'three'
import type { EdgeKind } from './model'

/** 微动角幅度（弧度，约 1.7°）与频率（Hz） */
const EAR_SWAY_RAD = 0.03
const EAR_SWAY_HZ = 0.7

function smoothstep(t: number, a: number, b: number): number {
  const x = Math.min(1, Math.max(0, (t - a) / (b - a)))
  return x * x * (3 - 2 * x)
}

interface EarVertex {
  index: number
  weight: number
  x: number
  y: number
  z: number
}

export class EdgeEarMotion {
  private mesh: THREE.Mesh | null = null
  private position: THREE.BufferAttribute | null = null
  private vertices: EarVertex[] = []
  private pivot = new THREE.Vector3()
  private axis = new THREE.Vector3(0, 0, 1)
  private elapsed = 0
  private disposed = false

  /**
   * 绑定模型几何。
   * @param loaded 模型根对象（已居中/贴地，未加入 root 前调用）
   * @param box 模型在 root 坐标系的包围盒（与 loaded 同一空间）
   * @param kind 边缘动作种类
   */
  attach(loaded: THREE.Object3D, box: THREE.Box3, kind: EdgeKind): void {
    loaded.updateMatrixWorld(true)
    // getObjectByProperty 递归查找主网格（避免在 traverse 闭包里赋值导致 TS 控制流收窄失败）
    const mesh = loaded.getObjectByProperty('isMesh', true) as THREE.Mesh | undefined
    if (!mesh) return
    const position = mesh.geometry.getAttribute('position') as THREE.BufferAttribute | undefined
    if (!position) return
    this.mesh = mesh
    this.position = position

    const inv = mesh.matrixWorld.clone().invert()
    // 旋转枢轴：探头取模型高度 60% 处（头/耳根附近）；悬挂取 45%（身体上部）
    const pivotRoot = new THREE.Vector3(
      0,
      kind === 'top' ? box.min.y + (box.max.y - box.min.y) * 0.45 : box.min.y + (box.max.y - box.min.y) * 0.6,
      0
    )
    this.pivot.copy(pivotRoot).applyMatrix4(inv)
    this.axis.set(0, 0, 1).transformDirection(inv).normalize()

    const world = new THREE.Vector3()
    const h = Math.max(0.01, box.max.y - box.min.y)
    const w = Math.max(0.01, box.max.x - box.min.x)
    for (let i = 0; i < position.count; i++) {
      world.fromBufferAttribute(position, i).applyMatrix4(mesh.matrixWorld)
      const weight = this.computeWeight(world, box, kind, h, w)
      if (weight <= 0.001) continue
      this.vertices.push({
        index: i,
        weight,
        x: position.getX(i),
        y: position.getY(i),
        z: position.getZ(i)
      })
    }
    if (this.vertices.length > 0) {
      console.log(`[pet] 边缘耳朵微动(${kind})绑定 ${this.vertices.length} 顶点`)
    }
  }

  update(dt: number): void {
    if (this.disposed || !this.position || this.vertices.length === 0) return
    this.elapsed += dt
    const angle = Math.sin(this.elapsed * Math.PI * 2 * EAR_SWAY_HZ) * EAR_SWAY_RAD
    if (Math.abs(angle) < 1e-5) return

    const p = this.position
    const axis = this.axis
    const pivot = this.pivot
    const v = new THREE.Vector3()
    const cross = new THREE.Vector3()
    for (const vertex of this.vertices) {
      const a = angle * vertex.weight
      const c = Math.cos(a)
      const s = Math.sin(a)
      v.set(vertex.x, vertex.y, vertex.z).sub(pivot)
      const dot = axis.dot(v)
      cross.crossVectors(axis, v)
      // Rodrigues：v' = v·cos + (axis×v)·sin + axis·(axis·v)·(1-cos)
      const rx = v.x * c + cross.x * s + axis.x * dot * (1 - c)
      const ry = v.y * c + cross.y * s + axis.y * dot * (1 - c)
      const rz = v.z * c + cross.z * s + axis.z * dot * (1 - c)
      p.setXYZ(
        vertex.index,
        pivot.x + rx,
        pivot.y + ry,
        pivot.z + rz
      )
    }
    p.needsUpdate = true
  }

  dispose(): void {
    this.disposed = true
    this.vertices = []
    this.mesh = null
    this.position = null
  }

  /** 耳朵区域权重（0 = 不动，1 = 满幅），按边缘方向选区域 */
  private computeWeight(
    p: THREE.Vector3,
    box: THREE.Box3,
    kind: EdgeKind,
    h: number,
    w: number
  ): number {
    if (kind === 'top') {
      // 悬挂：耳朵垂在下方两侧（越靠下、越靠外权重越高；避开身体中线）
      const down = (box.max.y - p.y) / h
      const side = Math.abs(p.x) / (w / 2)
      return smoothstep(down, 0.45, 0.9) * smoothstep(side, 0.3, 0.7)
    }
    // 探头：耳朵在模型上部，且位于远离身体切面的那一侧（下界避开眼睛/额头）
    const up = (p.y - box.min.y) / h
    const sideX =
      kind === 'left' ? (p.x - box.min.x) / w : (box.max.x - p.x) / w
    return smoothstep(up, 0.65, 0.95) * smoothstep(sideX, 0.35, 0.75)
  }
}
