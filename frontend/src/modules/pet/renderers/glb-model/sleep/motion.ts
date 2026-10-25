/**
 * 睡姿微动着色器（2026-10-19；2026-10-25 移除口水）。
 *
 * 睡姿 GLB 没有骨骼/morph，腹部呼吸只能注入材质着色器；一个
 * MeshStandardMaterial 只能设置一个 onBeforeCompile，GLSL 片段在 breath.ts。
 * 只改睡姿模型 clone 出来的材质，不碰站姿模型。
 */
import * as THREE from 'three'
import { BREATH_AMPLITUDE, BREATH_PERIOD_SECONDS } from './config'
import { breathVertexChunk } from './breath'

export interface SleepMotion {
  /** 每帧推进呼吸相位（秒） */
  update(dt: number): void
  dispose(): void
}

export function applySleepMotion(model: THREE.Object3D): SleepMotion | null {
  const uniforms = {
    uSleepTime: { value: 0 },
    uSleepAmp: { value: BREATH_AMPLITUDE }
  }
  let injected = false

  model.traverse((object) => {
    const mesh = object as THREE.Mesh
    if (!mesh.isMesh) return
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
    const cloned = materials.map((material) => {
      const standard = material as THREE.MeshStandardMaterial
      if (!standard.isMeshStandardMaterial) return material
      const next = standard.clone()
      next.onBeforeCompile = (shader) => {
        shader.uniforms.uSleepTime = uniforms.uSleepTime
        shader.uniforms.uSleepAmp = uniforms.uSleepAmp
        shader.vertexShader = shader.vertexShader
          .replace(
            '#include <common>',
            '#include <common>\nuniform float uSleepTime;\nuniform float uSleepAmp;'
          )
          .replace(
            '#include <begin_vertex>',
            `#include <begin_vertex>\n${breathVertexChunk()}`
          )
      }
      // 同一材质可能被多个 mesh 复用：固定 cache key，避免 Three 复用错 program
      next.customProgramCacheKey = () => 'pet-sleep-motion'
      next.needsUpdate = true
      injected = true
      return next
    })
    mesh.material = Array.isArray(mesh.material) ? cloned : cloned[0]
  })

  if (!injected) return null
  const sleepStep = (Math.PI * 2) / BREATH_PERIOD_SECONDS
  let sleepPhase = 0

  return {
    update(dt: number): void {
      sleepPhase = (sleepPhase + dt * sleepStep) % (Math.PI * 2)
      uniforms.uSleepTime.value = sleepPhase
    },
    dispose(): void {
      uniforms.uSleepTime.value = 0
    }
  }
}
