/**
 * pet 域出口（设计文档 §5.3）：对外只暴露 PetView 组件与渲染器抽象，
 * 渲染器内部细节（SVG 部件/动画实现）不外泄。
 */
export { default as PetView } from './PetView'
export { createPetRenderer, PENGUIN_CONFIG } from './renderers'
export type { PetRenderer, PetReactionKind, PetRendererKind } from './renderers'
