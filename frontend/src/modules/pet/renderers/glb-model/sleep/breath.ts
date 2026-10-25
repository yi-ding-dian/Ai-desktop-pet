/**
 * 睡姿腹部呼吸（GLSL 片段，2026-10-19）。
 *
 * 睡姿 GLB 没有骨骼、没有 morph target，无法用 AnimationMixer 做局部呼吸。
 * 这里按世界 Y 轴划出腹部区域，沿法线做正弦隆起；由 motion.ts 注入睡姿材质
 * 着色器（一个材质只能有一个 onBeforeCompile）。
 *
 * 为什么用世界坐标：模型节点自带绕 X 轴 +90° 旋转，局部 Y 轴并不对应上下；
 * `modelMatrix * transformed` 才是最终屏幕空间里的上下方向。
 */
import {
  BREATH_FADE_Y,
  BREATH_MAX_Y,
  BREATH_MIN_Y
} from './config'

export function breathVertexChunk(): string {
  return `
    vec4 sleepWorld = modelMatrix * vec4(transformed, 1.0);
    float belly = smoothstep(${BREATH_MIN_Y.toFixed(3)}, ${(
      BREATH_MIN_Y + BREATH_FADE_Y
    ).toFixed(3)}, sleepWorld.y)
      * (1.0 - smoothstep(${BREATH_MAX_Y.toFixed(3)}, ${(
      BREATH_MAX_Y + BREATH_FADE_Y
    ).toFixed(3)}, sleepWorld.y));
    transformed += normalize(objectNormal) * (sin(uSleepTime) * 0.5 + 0.5)
      * uSleepAmp * belly;
  `
}
