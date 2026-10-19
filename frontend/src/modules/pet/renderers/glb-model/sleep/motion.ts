/**
 * 睡姿微动着色器（2026-10-19）：把"腹部呼吸""口水摆动""口水淡入"注入同一个材质。
 *
 * 一个 MeshStandardMaterial 只能设置一个 onBeforeCompile，所以几个效果必须在
 * 同一个回调里合并；各自的 GLSL 片段分别在 breath.ts / drool.ts。
 *
 * 口水淡入只对深睡模型启用：顶点着色器把口水区域权重传给片元，片元用
 * `uDroolAlpha` 控制该区域 alpha，实现"睡着 10 秒后口水慢慢出现"。
 * 只改睡姿模型 clone 出来的材质，不碰站姿模型。
 */
import * as THREE from 'three'
import { BREATH_AMPLITUDE, BREATH_PERIOD_SECONDS } from './config'
import { breathVertexChunk } from './breath'
import { DROOL_PERIOD_SECONDS, droolVertexChunk } from './drool'

export interface SleepMotionOptions {
  /** 是否启用口水 alpha 淡入（仅深睡模型） */
  droolAlpha?: boolean
}

export interface SleepMotion {
  /** 每帧推进呼吸/口水相位（秒） */
  update(dt: number): void
  /** 口水显隐：0=隐藏，1=完全显示 */
  setDroolAlpha(value: number): void
  dispose(): void
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value
}

export function applySleepMotion(
  model: THREE.Object3D,
  options: SleepMotionOptions = {}
): SleepMotion | null {
  const droolAlpha = options.droolAlpha === true
  const uniforms = {
    uSleepTime: { value: 0 },
    uDroolTime: { value: 0 },
    uSleepAmp: { value: BREATH_AMPLITUDE },
    uDroolAlpha: { value: 1 }
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
      // 口水区域 alpha 渐变需要透明材质；模型其余区域 alpha 仍为 1
      if (droolAlpha) next.transparent = true
      next.onBeforeCompile = (shader) => {
        shader.uniforms.uSleepTime = uniforms.uSleepTime
        shader.uniforms.uDroolTime = uniforms.uDroolTime
        shader.uniforms.uSleepAmp = uniforms.uSleepAmp
        shader.uniforms.uDroolAlpha = uniforms.uDroolAlpha
        shader.vertexShader = shader.vertexShader
          .replace(
            '#include <common>',
            '#include <common>\nuniform float uSleepTime;\nuniform float uDroolTime;\nuniform float uSleepAmp;\nvarying float vDroolMask;'
          )
          .replace(
            '#include <begin_vertex>',
            `#include <begin_vertex>\n${breathVertexChunk()}\n${droolVertexChunk()}`
          )
        if (droolAlpha) {
          shader.fragmentShader = shader.fragmentShader
            .replace(
              '#include <common>',
              '#include <common>\nuniform float uDroolAlpha;\nvarying float vDroolMask;'
            )
            .replace(
              '#include <dithering_fragment>',
              `#include <dithering_fragment>
              // 口水识别：几何窗口只覆盖尖端，主体用 baseColor 的浅蓝色区分
              // （口水 B 明显高于 R；白毛/绿背心/粉耳朵都不满足）
              float droolColor = smoothstep(0.02, 0.12, diffuseColor.b - diffuseColor.r);
              float droolMask = max(clamp(vDroolMask, 0.0, 1.0), droolColor);
              gl_FragColor.a *= mix(1.0, uDroolAlpha, droolMask);`
            )
        }
      }
      // 同一材质可能被多个 mesh 复用：固定 cache key，避免 Three 复用错 program
      next.customProgramCacheKey = () => (droolAlpha ? 'pet-sleep-motion-deep' : 'pet-sleep-motion')
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
    setDroolAlpha(value: number): void {
      uniforms.uDroolAlpha.value = clamp01(value)
    },
    dispose(): void {
      uniforms.uSleepTime.value = 0
      uniforms.uDroolTime.value = 0
    }
  }
}
