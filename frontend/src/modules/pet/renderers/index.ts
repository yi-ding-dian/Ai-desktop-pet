/**
 * 渲染器工厂（可插拔渲染器的"插座"，设计文档 §5.3）。
 *
 * - 'glb-model'：**当前默认**——加载 Meshy 生成的兔子 GLB（静态网格，无骨骼无动画），
 *   以"整体姿态"表达情绪/状态（详见 glb-model/ 内注释）；
 * - 'three-d'：Three.js 程序化 3D 几何拼装（软胶玩具风企鹅 / 程序化兔子，保留可切换）；
 *   目录名 procedural-3d（原 three-d 的自造拼写）；kind id 保持 'three-d' 以兼容已存 localStorage。
 * - 'part-animation'：程序化 SVG 部件动画（首个实现，零依赖；保留可切换）；
 * - 'live2d'（将来）：pixi-live2d-display + Cubism 模型。实现后只需在此注册，
 *   调用方（PetView 等）零改动——这是"换渲染器不改调用方"的落点。
 *
 * 运行时切换（最小实现，便于对比/回退）：localStorage 键 `pet-renderer` 覆盖缺省值。
 *   例：devtools 里 `localStorage.setItem('pet-renderer', 'three-d')` 后刷新页面。
 */
import type { PetRenderer } from './types'
import { PartAnimationRenderer } from './part-animation'
import { ThreeDRenderer } from './procedural-3d'
import { GlbModelRenderer } from './glb-model'

export type PetRendererKind = 'glb-model' | 'three-d' | 'part-animation' | 'live2d'

/** 缺省渲染器（用户 2026-10-15 决策：GLB 模型版兔子——外观还原度优先） */
export const DEFAULT_PET_RENDERER: PetRendererKind = 'glb-model'

/** localStorage 覆盖键（缺省渲染器切换用；非法值忽略） */
const OVERRIDE_KEY = 'pet-renderer'

const VALID_KINDS: ReadonlySet<string> = new Set(['glb-model', 'three-d', 'part-animation'])

/** 解析当前应使用的渲染器：localStorage 覆盖 → 缺省 */
export function resolvePetRendererKind(): PetRendererKind {
  try {
    const override = window.localStorage.getItem(OVERRIDE_KEY)
    if (override && VALID_KINDS.has(override)) return override as PetRendererKind
  } catch {
    /* localStorage 不可用（隐私模式等）：走缺省 */
  }
  return DEFAULT_PET_RENDERER
}

/** 创建渲染器实例（kind 缺省 = localStorage 覆盖值，再缺省 = 'glb-model'） */
export function createPetRenderer(kind?: PetRendererKind): PetRenderer {
  const resolved = kind ?? resolvePetRendererKind()
  switch (resolved) {
    case 'glb-model':
      return new GlbModelRenderer()
    case 'three-d':
      return new ThreeDRenderer()
    case 'part-animation':
      return new PartAnimationRenderer()
    case 'live2d':
      // TODO(设计文档 §5.3)：接入 pixi-live2d-display 后在此返回 Live2DRenderer
      throw new Error('[pet] live2d 渲染器尚未实现（Phase 1 后续，见设计文档 §5.3）')
  }
}

export type { PetRenderer, PetReactionKind, PetRendererName } from './types'
export { PENGUIN_CONFIG } from './part-animation'
export { PENGUIN_3D_CONFIG } from './procedural-3d'
