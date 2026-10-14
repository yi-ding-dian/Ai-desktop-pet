/**
 * pet 域出口（设计文档 §5.3）：对外只暴露 PetView 组件、渲染器抽象与轻量控制器，
 * 渲染器内部细节（SVG 部件/动画实现）不外泄。
 */
export { default as PetView } from './PetView'
export { createPetRenderer, PENGUIN_CONFIG } from './renderers'
export type { PetRenderer, PetReactionKind, PetRendererKind } from './renderers'
// 轻量控制器：voice 域口型驱动 → setPetMouth；setActivePetRenderer 仅供 PetView 使用
export { setActivePetRenderer, setPetMouth } from './controller'
