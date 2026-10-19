/**
 * 睡姿微动着色器（2026-10-19）：把"腹部呼吸"和"口水摆动"注入同一个材质。
 *
 * 一个 MeshStandardMaterial 只能设置一个 onBeforeCompile，所以两个效果必须
 * 在同一个回调里合并；各自的 GLSL 片段分别在 breath.ts / drool.ts。
 * 只改睡姿模型 clone 出来的材质，不碰站姿模型。
 */
import * as THREE from 'three'
import { BREATH_AMPLITUDE, BREATH_PERIOD_SECONDS } from './config'
import { breathVertexChunk } from './breath'
import { DROOL_PERIOD_SECONDS, droolVertexChunk } from './drool'

export interface SleepMotion {
  /** 每帧推进呼吸/口水相位（秒） */
  update(dt: number): void
  dispose(): void
}

export function applySleepMotion(model: THREE.Object3D): SleepMotion | null {
  const uniforms = {
    uSleepTime: { value: 0 },
    uDroolTime: { value: 0 },
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
        shader.uniforms.uDroolTime = uniforms.uDroolTime
        shader.uniforms.uSleepAmp = uniforms.uSleepAmp
        shader.vertexShader = shader.vertexShader
          .replace(
            '#include <common>',
            '#include <common>\nuniform float uSleepTime;\nuniform float uDroolTime;\nuniform float uSleepAmp;'
          )
          .replace(
            '#include <begin_vertex>',
            `#include <begin_vertex>\n${breathVertexChunk()}\n${droolVertexChunk()}`
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
  const droolStep = (Math.PI * 2) / DROOL_PERIOD_SECONDS
  let sleepPhase = 0
  let droolPhase = 0

  return {
    update(dt: number): void {
      sleepPhase = (sleepPhase + dt * sleepStep) % (Math.PI * 2)
      droolPhase = (droolPhase + dt * droolStep) % (Math.PI * 2)
      uniforms.uSleepTime.value = sleepPhase
      uniforms.uDroolTime.value = droolPhase
    },
    dispose(): void {
      uniforms.uSleepTime.value = 0
      uniforms.uDroolTime.value = 0
    }
  }
}
