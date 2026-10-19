/**
 * 释放一棵对象树中的几何/材质/贴图（Set 去重，避免共享资源重复释放）。
 * 从 glb-model/index.ts 抽出，供站姿模型与睡姿子模块共用。
 */
import * as THREE from 'three'

export function disposeObjectResources(obj: THREE.Object3D): void {
  const geometries = new Set<THREE.BufferGeometry>()
  const materials = new Set<THREE.Material>()
  const textures = new Set<THREE.Texture>()
  obj.traverse((o) => {
    const mesh = o as THREE.Mesh
    if (!mesh.isMesh) return
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
