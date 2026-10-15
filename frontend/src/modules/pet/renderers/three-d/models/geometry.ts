/**
 * 3D 模型共享几何工具（两模型通用；只放"圆钝可爱"造型基元，不放任何造型参数）。
 */
import * as THREE from 'three'
import type { Ellipsoid, Vec3 } from '../config'

export const v3 = (v: Vec3): THREE.Vector3 => new THREE.Vector3(v.x, v.y, v.z)

/** 椭球网格：单位球 + scale（圆钝轮廓的唯一来源） */
export function ellipsoid(geo: THREE.SphereGeometry, mat: THREE.Material, e: Ellipsoid): THREE.Mesh {
  const mesh = new THREE.Mesh(geo, mat)
  mesh.position.copy(v3(e.center))
  mesh.scale.copy(v3(e.scale))
  if (e.rotX) mesh.rotation.x = e.rotX
  if (e.rotZ) mesh.rotation.z = e.rotZ
  return mesh
}

/**
 * 圆钝心形（挤出体）：宽 1 / 高约 0.95（以原点为中心），底部圆弧收口无尖角。
 * 轮廓（顺时针）：底部圆角 → 右叶外缘 → 中缝凹点 → 左叶 → 回到底部。
 */
export function buildHeartGeometry(size: number): THREE.ExtrudeGeometry {
  const s = new THREE.Shape()
  s.moveTo(-0.16, -0.28)
  s.quadraticCurveTo(0, -0.54, 0.16, -0.28) // 底部圆钝收口（无尖角）
  s.bezierCurveTo(0.54, -0.14, 0.56, 0.28, 0.29, 0.40) // 右叶外缘
  s.bezierCurveTo(0.15, 0.46, 0.05, 0.35, 0, 0.24) // 右叶内侧 → 中缝凹点
  s.bezierCurveTo(-0.05, 0.35, -0.15, 0.46, -0.29, 0.40) // 中缝 → 左叶内侧
  s.bezierCurveTo(-0.56, 0.28, -0.54, -0.14, -0.16, -0.28) // 左叶外缘 → 回起点
  const geo = new THREE.ExtrudeGeometry(s, {
    depth: 0.30,
    bevelEnabled: true,
    bevelThickness: 0.12,
    bevelSize: 0.10,
    bevelSegments: 3,
    curveSegments: 16
  })
  geo.center()
  geo.scale(size, size, size)
  return geo
}

/** 资源登记器：模型 build 内跟踪几何/材质，dispose 统一释放 */
export interface ResourceTracker {
  trackG<T extends THREE.BufferGeometry>(g: T): T
  trackM<T extends THREE.Material>(m: T): T
  disposeAll(): void
}

export function createResourceTracker(): ResourceTracker {
  const geos: THREE.BufferGeometry[] = []
  const mats: THREE.Material[] = []
  return {
    trackG: (g) => {
      geos.push(g)
      return g
    },
    trackM: (m) => {
      mats.push(m)
      return m
    },
    disposeAll(): void {
      for (const g of geos) g.dispose()
      for (const m of mats) m.dispose()
    }
  }
}

/** 软胶玩具材质（适度粗糙 + 轻微高光）——两模型共用质感基调 */
export function softMaterial(
  trackM: ResourceTracker['trackM'],
  color: string,
  roughness = 0.62,
  metalness = 0.02
): THREE.MeshStandardMaterial {
  return trackM(new THREE.MeshStandardMaterial({ color, roughness, metalness }))
}

// ------------------------------------------------------------------ 卡通渲染（Toon + 描边）

/**
 * 绒毛材质（soft 3D 毛绒感）：MeshPhysicalMaterial + **sheen**（绒毛边缘光——Three.js 里
 * 最接近绒毛质感的内置手段）+ 高粗糙度、无金属、无塑料高光。配合大面积柔和漫射光使用。
 */
export function fluffyMaterial(
  trackM: ResourceTracker['trackM'],
  color: string,
  opts: {
    sheenColor?: string
    sheen?: number
    sheenRoughness?: number
    roughness?: number
    transparent?: boolean
    opacity?: number
    depthWrite?: boolean
    side?: THREE.Side
  } = {}
): THREE.MeshPhysicalMaterial {
  return trackM(
    new THREE.MeshPhysicalMaterial({
      color,
      roughness: opts.roughness ?? 0.92,
      metalness: 0.0,
      sheen: opts.sheen ?? 1.0,
      sheenColor: new THREE.Color(opts.sheenColor ?? '#FFF6EC'),
      sheenRoughness: opts.sheenRoughness ?? 0.55,
      transparent: opts.transparent ?? false,
      opacity: opts.opacity ?? 1,
      depthWrite: opts.depthWrite ?? true,
      side: opts.side ?? THREE.FrontSide
    })
  )
}

/**
 * 绒毛边缘壳（"绒毛光晕"）：同几何背面、**浅暖白半透明**，作为 mesh 子件按世界厚度均匀外扩。
 * 原理与 inverted-hull 描边相同，但材质是浅色半透明（而非深色）——在轮廓边缘形成一圈
 * 柔和"毛茸茸"的光边（逆光绒毛感），不产生描边线条。
 */
export function addFluffShell(
  trackM: ResourceTracker['trackM'],
  mesh: THREE.Mesh,
  worldThickness = 0.02,
  color = '#FFFDF6',
  opacity = 0.5
): THREE.Mesh {
  const mat = trackM(new THREE.MeshBasicMaterial({ color, transparent: true, opacity, side: THREE.BackSide, depthWrite: false }))
  const shell = new THREE.Mesh(mesh.geometry, mat)
  const d = worldThickness
  shell.scale.set(1 + d / mesh.scale.x, 1 + d / mesh.scale.y, 1 + d / mesh.scale.z)
  shell.renderOrder = -1
  mesh.add(shell)
  return shell
}

/** Toon 分带梯度图（3 阶；模块级共享，只建一次） */
let toonGradient: THREE.DataTexture | null = null
export function getToonGradient(): THREE.DataTexture {
  if (!toonGradient) {
    // 3 档明暗（暗/中/亮）：整体偏亮、档差小（白物体接近平涂不显脏）。
    // 用 RGBA 数据纹理（而非 RedFormat）——部分 ANGLE/驱动组合对单通道纹理采样异常，
    // 会把光照压到最暗档导致整体发灰（离屏预览实测踩到）。
    const data = new Uint8Array([
      200, 200, 200, 255, // 暗档
      232, 232, 232, 255, // 中档
      255, 255, 255, 255 // 亮档
    ])
    const tex = new THREE.DataTexture(data, 3, 1, THREE.RGBAFormat)
    tex.minFilter = THREE.NearestFilter
    tex.magFilter = THREE.NearestFilter
    tex.generateMipmaps = false
    tex.needsUpdate = true
    toonGradient = tex
  }
  return toonGradient
}

/**
 * 卡通材质（MeshToonMaterial + 3 阶分带）：近似平涂、无塑料高光——
 * 手绘表情包 IP 3D 化的标准材质（颜色高饱和、明暗仅两三档）。
 */
export function toonMaterial(
  trackM: ResourceTracker['trackM'],
  color: string,
  opts: { transparent?: boolean; opacity?: number; depthWrite?: boolean; side?: THREE.Side } = {}
): THREE.MeshToonMaterial {
  return trackM(
    new THREE.MeshToonMaterial({
      color,
      gradientMap: getToonGradient(),
      transparent: opts.transparent ?? false,
      opacity: opts.opacity ?? 1,
      depthWrite: opts.depthWrite ?? true,
      side: opts.side ?? THREE.FrontSide
    })
  )
}

/**
 * inverted-hull 描边（卡通轮廓线的灵魂）：同几何背面深色壳、**世界厚度均匀**放大。
 * 实现：作为 mesh 的子件，child 世界半径 = parent.scale × child.scale，要得到各轴
 * "半径 + d"（世界厚度一致，压扁椭球也不会畸变），child.scale = (s + d) / s。
 * 只给"大件外轮廓"用（头/身体/耳/手/脚/马甲/尾巴）；贴面件（眼/腮红/内耳/嘴线）不加。
 */
export function addOutlineHull(
  trackM: ResourceTracker['trackM'],
  mesh: THREE.Mesh,
  worldThickness = 0.022,
  color = '#3A3A3A'
): THREE.Mesh {
  const mat = trackM(new THREE.MeshBasicMaterial({ color, side: THREE.BackSide }))
  const hull = new THREE.Mesh(mesh.geometry, mat)
  const d = worldThickness
  hull.scale.set(1 + d / mesh.scale.x, 1 + d / mesh.scale.y, 1 + d / mesh.scale.z)
  mesh.add(hull) // 位置/旋转继承（壳与实体同心）
  return hull
}

/** 眼部材质（透明 + 不写深度：opacity 做情绪淡入淡出且不遮挡弧线/眉） */
export function eyeMaterials(
  trackM: ResourceTracker['trackM'],
  c: { eyeWhite: string; pupil: string; highlight: string; arc: string; brow: string }
): {
  white: THREE.MeshStandardMaterial
  pupil: THREE.MeshStandardMaterial
  highlight: THREE.MeshBasicMaterial
  arc: THREE.MeshStandardMaterial
  brow: THREE.MeshStandardMaterial
} {
  return {
    white: trackM(
      new THREE.MeshStandardMaterial({
        color: c.eyeWhite,
        roughness: 0.28,
        metalness: 0.0,
        transparent: true,
        depthWrite: false
      })
    ),
    pupil: trackM(
      new THREE.MeshStandardMaterial({
        color: c.pupil,
        roughness: 0.18,
        metalness: 0.0,
        transparent: true,
        depthWrite: false
      })
    ),
    // 高光用 Basic（不受光，永远亮白）——"大眼萌"的核心高光点
    highlight: trackM(new THREE.MeshBasicMaterial({ color: c.highlight, transparent: true, depthWrite: false })),
    arc: trackM(
      new THREE.MeshStandardMaterial({ color: c.arc, roughness: 0.3, transparent: true, depthWrite: false })
    ),
    brow: trackM(
      new THREE.MeshStandardMaterial({ color: c.brow, roughness: 0.5, transparent: true, depthWrite: false })
    )
  }
}

/** 心形粒子材质工厂（默认 Standard；toon 模型传入 toon 版保持风格统一） */
export type HeartMaterialFactory = (
  trackM: ResourceTracker['trackM'],
  color: string
) => THREE.MeshStandardMaterial | THREE.MeshToonMaterial | THREE.MeshPhysicalMaterial

const defaultHeartMaterial: HeartMaterialFactory = (trackM, color) =>
  trackM(
    new THREE.MeshStandardMaterial({
      color,
      roughness: 0.4,
      emissive: new THREE.Color(color),
      emissiveIntensity: 0.35,
      transparent: true,
      depthWrite: false,
      opacity: 0
    })
  )

/** 心形粒子（各自材质：错开淡出 + 微发光）+ 锚点定位 */
export function buildHearts(
  trackM: ResourceTracker['trackM'],
  geoHeart: THREE.BufferGeometry,
  anchors: ReadonlyArray<{ pos: Vec3; delayMs: number; sway: number }>,
  color: string,
  parent: THREE.Object3D,
  makeMaterial: HeartMaterialFactory = defaultHeartMaterial
): {
  hearts: THREE.Mesh[]
  heartMaterials: Array<THREE.MeshStandardMaterial | THREE.MeshToonMaterial | THREE.MeshPhysicalMaterial>
} {
  const hearts: THREE.Mesh[] = []
  const heartMaterials: Array<THREE.MeshStandardMaterial | THREE.MeshToonMaterial | THREE.MeshPhysicalMaterial> = []
  for (const a of anchors) {
    const mat = makeMaterial(trackM, color)
    const m = new THREE.Mesh(geoHeart, mat)
    m.position.copy(v3(a.pos))
    m.visible = false
    heartMaterials.push(mat)
    hearts.push(m)
    parent.add(m) // 挂在根（不受呼吸缩放/倾斜影响，独立飘出）
  }
  return { hearts, heartMaterials }
}
