/** 剪贴板写入：走主进程（2026-10-26 从 work/format.ts 拆出）。 */
import { getPetBridge } from '../../shared/pet-bridge'

export function copyText(text: string): void {
  if (!text) return
  try {
    // 主进程写剪贴板（异步）：失败只影响这次复制，不弹错
    void Promise.resolve(getPetBridge().system.copyText(text)).catch(() => undefined)
  } catch {
    /* 旧 preload：静默降级 */
  }
}
