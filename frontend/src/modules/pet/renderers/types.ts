/**
 * PetRenderer：宠物渲染器统一接口（设计文档 §5.3 的"可插拔渲染器"落地）。
 *
 * 设计目标：**换渲染器，不改调用方**。
 * - 当前实现：`part-animation/`（程序化 SVG 部件动画，纯 rAF 驱动，零依赖）——本目录第一个实现；
 * - 将来实现：`live2d/`（pixi-live2d-display + Cubism 模型，含自带 speak() 口型），
 *   只需实现同一接口并在 renderers/index.ts 的工厂里注册，PetView 等调用方零改动；
 * - 调用方（src/modules/pet/PetView.tsx）只依赖本接口，不感知具体渲染技术（SVG / Pixi 画布）。
 *
 * 生命周期约定：
 *   createPetRenderer() → mount(container) → [setEmotion / setState / setMouth / playReaction...]
 *   → unmount()（可再次 mount）或 dispose()（彻底释放，不可再用）。
 * 渲染循环由实现自持（rAF / Pixi ticker），**不依赖 React 重渲染**（设计文档 §5.3：渲染循环独立于 React）。
 */
import type { PetState } from '../../../shared/protocol'

/** 即时反应种类（手势/事件触发的短效动作，播放后自动结束，叠加在情绪表现之上） */
export type PetReactionKind = 'pet' // 摸头；预留扩展：'poke'（戳）/ 'hug' / 'drag_pickup' 等

/** 渲染器标识（日志与调试展示） */
export type PetRendererName = 'part-animation' | 'live2d'

export interface PetRenderer {
  /** 渲染器标识（日志/调试用） */
  readonly name: PetRendererName

  /**
   * 挂载到容器 DOM 并启动渲染循环。
   * 重复调用应先卸载旧内容（幂等）；容器尺寸变化由实现自行监听/自适应。
   */
  mount(container: HTMLElement): void

  /** 从 DOM 卸载并停止渲染循环；之后可再次 mount（与 dispose 的区别：资源仍可复用） */
  unmount(): void

  /**
   * 设置情绪（订阅 WS `emotion` 事件后驱动）。
   * @param emotion 后端情绪标签（白名单外/未知值回退 neutral）
   * @param intensity 强度 0–1（缺省 1）：影响表情幅度（如笑得更开/脸更红），不改变表情种类
   */
  setEmotion(emotion: string, intensity?: number): void

  /** 设置宠物状态机状态（订阅 WS `state` 事件后驱动）；thinking/speaking/sleeping 等有专属表现 */
  setState(state: PetState): void

  /**
   * 设置口型开合度（TTS 未接：Phase 2 由音量包络或 WordBoundary 驱动）。
   * @param level 0（闭合）– 1（全开）
   * 注：state=speaking 且本接口未被调用时，实现内置"模拟说话"口型兜底，保证状态可见。
   */
  setMouth(level: number): void

  /** 播放一次即时反应（摸头等）；可重入（重复触发重置进度），播放后自动回到当前情绪姿态 */
  playReaction(kind: PetReactionKind): void

  /** 彻底释放：卸载 + 释放内部资源，之后不可再用（React 卸载 / 切换渲染器时调用） */
  dispose(): void
}
