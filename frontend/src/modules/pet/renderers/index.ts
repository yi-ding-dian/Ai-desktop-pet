/**
 * 渲染器工厂（可插拔渲染器的"插座"，设计文档 §5.3）。
 *
 * - 'part-animation'：程序化 SVG 部件动画（当前默认实现，零依赖）；
 * - 'live2d'（将来）：pixi-live2d-display + Cubism 模型。实现后只需在此注册，
 *   调用方（PetView 等）零改动——这是"换渲染器不改调用方"的落点。
 */
import type { PetRenderer } from './types'
import { PartAnimationRenderer } from './part-animation'

export type PetRendererKind = 'part-animation' | 'live2d'

/** 创建渲染器实例（kind 缺省 = 部件动画） */
export function createPetRenderer(kind: PetRendererKind = 'part-animation'): PetRenderer {
  switch (kind) {
    case 'part-animation':
      return new PartAnimationRenderer()
    case 'live2d':
      // TODO(设计文档 §5.3)：接入 pixi-live2d-display 后在此返回 Live2DRenderer
      throw new Error('[pet] live2d 渲染器尚未实现（Phase 1 后续，见设计文档 §5.3）')
  }
}

export type { PetRenderer, PetReactionKind, PetRendererName } from './types'
export { PENGUIN_CONFIG } from './part-animation'
