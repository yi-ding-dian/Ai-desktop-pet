/** 任务域取 agent bridge：兼容旧 preload（拿不到时返回 undefined）。 */
import { getPetBridge } from '../../shared/pet-bridge'

export function agentBridge(): ReturnType<typeof getPetBridge>['agent'] | undefined {
  try {
    return getPetBridge().agent
  } catch {
    return undefined
  }
}
