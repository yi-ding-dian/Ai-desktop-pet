/**
 * pet 域轻量控制器：模块级单例，向其他域（当前为 voice 口型驱动）暴露宠物渲染能力。
 *
 * 为什么这么做（设计文档 §5.3 "换渲染器不改调用方"的延伸）：
 * - voice 域不应知道渲染器实例/React 挂载细节，也不引入状态库（任务约定：最简方案）；
 * - PetView 挂载渲染器后注册到此，卸载时注销；未挂载期间所有调用都是安全空操作。
 */
import type { PetRenderer } from './renderers'

/** 当前挂载中的渲染器（null = 宠物未挂载/已卸载） */
let activeRenderer: PetRenderer | null = null

/** PetView 专用：注册/注销当前活跃渲染器（其余域不要调用） */
export function setActivePetRenderer(renderer: PetRenderer | null): void {
  activeRenderer = renderer
}

/**
 * 设置当前宠物口型开合度（voice 域口型驱动调用；0=闭合 1=全开）。
 * 渲染器未挂载/已释放时静默忽略。
 */
export function setPetMouth(level: number): void {
  activeRenderer?.setMouth(level)
}
