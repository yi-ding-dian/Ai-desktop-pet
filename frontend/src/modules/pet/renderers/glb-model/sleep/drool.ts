/**
 * 口水小幅摆动（GLSL 片段，2026-10-19）。
 *
 * 口水是睡姿单网格里的一小片顶点（baseColor 浅蓝色、嘴下方），没有独立节点 /
 * 骨骼 / morph。用局部坐标窗口选中它（节点旋转前的几何坐标）：
 *   x ≈ [-0.05, -0.01] / y ≈ [0.27, 0.29] / z ≈ [-0.03, -0.01]
 * 只做 0.006 左右的左右/上下摆动，像一滴口水轻轻晃。
 *
 * 为什么不用 UV/贴图颜色选顶点：顶点着色器里采样贴图需要 vertex texture fetch，
 * 兼容性和开销都不划算；坐标窗口足够窄，不会带动嘴/下巴。
 */
export const DROOL_PERIOD_SECONDS = 2.6

export function droolVertexChunk(): string {
  return `
    float droolMask = smoothstep(-0.085, -0.060, transformed.x)
      * (1.0 - smoothstep(0.000, 0.012, transformed.x))
      * smoothstep(0.250, 0.265, transformed.y)
      * (1.0 - smoothstep(0.295, 0.305, transformed.y))
      * smoothstep(-0.055, -0.040, transformed.z)
      * (1.0 - smoothstep(0.000, 0.008, transformed.z));
    // 根部（靠近嘴，local z 更负）固定，尖端（local z 更大）摆动
    float droolTip = smoothstep(-0.033, -0.012, transformed.z);
    transformed.x += (sin(uDroolTime) * 0.008 + sin(uDroolTime * 2.1 + 1.7) * 0.0025)
      * droolMask * droolTip;
    transformed.z += cos(uDroolTime * 0.9) * 0.004 * droolMask * droolTip;
  `
}
