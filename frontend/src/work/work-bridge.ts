/** work 段 bridge：旧 preload（主进程未重启）时返回 undefined，调用方静默降级。 */
import { getPetBridge } from '../shared/pet-bridge'

export function workBridge(): ReturnType<typeof getPetBridge>['work'] | undefined {
  try {
    return getPetBridge().work
  } catch {
    return undefined
  }
}
