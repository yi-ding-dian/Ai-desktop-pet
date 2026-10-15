/**
 * pet 域自主行为接线（Phase 3，设计文档 §4.5.5 / §7.4）。
 *
 * - 行为执行器（executor.ts）：WS behavior 指令 → 本地执行（窗口缓动 + 动画）→ 回报；
 * - 环境上报（env-reporter.ts）：连接就绪/几何变化/pet_state 变化/定时 → env_update；
 * - 本文件是 pet 域对外的接线口：App 挂载时 setup，PetView/App 经 interruptPetBehavior 打断。
 */
import type { WsClient } from '../../../shared/ws-client'
import { BehaviorExecutor, type BehaviorStatus } from './executor'
import { setupEnvReporter } from './env-reporter'

export type { BehaviorStatus } from './executor'

/** 当前活跃的执行器（App 接线时创建；打断/调试入口经它转发） */
let activeExecutor: BehaviorExecutor | null = null

/**
 * 接线自主行为（行为执行器 + 环境上报）；返回清理函数。
 * 由 App 在挂载时调用一次（StrictMode 双调用安全：重复 setup 会替换旧实例）。
 */
export function setupPetBehaviors(client: WsClient): () => void {
  const executor = new BehaviorExecutor(client)
  activeExecutor = executor
  const disposers = [executor.start(), setupEnvReporter(client)]
  return () => {
    disposers.forEach((dispose) => dispose())
    if (activeExecutor === executor) activeExecutor = null
  }
}

/**
 * 中断当前行为（用户开始摸头/拖拽时由 App 的 hitbox pointerdown 调用）。
 * 无进行中的行为时是安全空操作。
 */
export function interruptPetBehavior(reason: string): void {
  activeExecutor?.interrupt(reason)
}

/**
 * dev 调试入口（PetView 的 W 键）：本地注入一条行为指令，走与真实指令相同的
 * 执行/回报路径（behavior_done 会发往后端，因 id 不匹配被引擎忽略——预期行为）。
 */
export function debugTriggerBehavior(name = 'walk', params?: Record<string, unknown>): void {
  if (!activeExecutor) {
    console.warn('[pet/behavior] 执行器未接线，调试行为已忽略')
    return
  }
  const data = {
    id: `dbg_${Date.now().toString(36)}`,
    name,
    params:
      params ??
      (name === 'walk'
        ? { direction: 'right', distance: 300, duration_ms: 2200 }
        : { duration_ms: 3000 })
  }
  activeExecutor.handle(data)
}

/** 订阅行为执行状态（App 状态栏显示"它正在做什么"）；返回取消订阅函数 */
export function subscribeBehaviorStatus(
  cb: (status: BehaviorStatus | null) => void
): () => void {
  return activeExecutor?.onStatus(cb) ?? (() => {})
}
