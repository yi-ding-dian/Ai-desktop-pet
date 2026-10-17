/**
 * pet 域出口（设计文档 §5.3）：对外只暴露 PetView 组件、渲染器抽象、轻量控制器
 * 与自主行为接线；渲染器内部细节（SVG 部件/动画实现）不外泄。
 */
export { default as PetView } from './PetView'
export { createPetRenderer, PENGUIN_CONFIG } from './renderers'
export type { PetRenderer, PetReactionKind, PetRendererKind } from './renderers'
// 轻量控制器：voice 域口型驱动 → setPetMouth；行为执行器 → setPetState/playPetReaction；
// setPetEmotion 供 PetView（WS 情绪入口，带自动回落）；setPetConversationActive 供 App
// （转发"对话/说话进行中"信号）；setActivePetRenderer 仅供 PetView 使用
export {
  setActivePetRenderer,
  setPetMouth,
  setPetState,
  playPetReaction,
  setPetEmotion,
  setPetConversationActive
} from './controller'
// 自主行为接线（Phase 3）：App 挂载时 setup；打断/调试入口给 App 与 PetView 用
export {
  setupPetBehaviors,
  interruptPetBehavior,
  debugTriggerBehavior,
  subscribeBehaviorStatus
} from './behavior'
export type { BehaviorStatus } from './behavior'
// 空气让路（§5.1 增补）：App 的旧"hitbox 悬停切穿透"逻辑据此短路（渲染器实现 hitTest 时停用）
export { isPixelHitTestActive } from './pixel-hit-test'
