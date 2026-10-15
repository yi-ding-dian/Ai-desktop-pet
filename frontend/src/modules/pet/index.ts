/**
 * pet 域出口（设计文档 §5.3）：对外只暴露 PetView 组件、渲染器抽象、轻量控制器
 * 与自主行为接线；渲染器内部细节（SVG 部件/动画实现）不外泄。
 */
export { default as PetView } from './PetView'
export { createPetRenderer, PENGUIN_CONFIG } from './renderers'
export type { PetRenderer, PetReactionKind, PetRendererKind } from './renderers'
// 轻量控制器：voice 域口型驱动 → setPetMouth；行为执行器 → setPetState/playPetReaction；
// setActivePetRenderer 仅供 PetView 使用
export { setActivePetRenderer, setPetMouth, setPetState, playPetReaction } from './controller'
// 自主行为接线（Phase 3）：App 挂载时 setup；打断/调试入口给 App 与 PetView 用
export {
  setupPetBehaviors,
  interruptPetBehavior,
  debugTriggerBehavior,
  subscribeBehaviorStatus
} from './behaviors'
export type { BehaviorStatus } from './behaviors'
