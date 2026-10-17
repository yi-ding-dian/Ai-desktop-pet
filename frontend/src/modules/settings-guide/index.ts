/**
 * 设置向导域（P4 §7.6.6）：宠物面的向导 UI 接线——气泡显隐 + 聊天面板收起依据。
 *
 * 职责（单一）：订阅主进程 `SETTINGS_VISIBILITY`（opened / saved / closed）→ 归一为
 * "向导进行中"布尔 → 分发给 App（App 据此：聊天面板收起 + 渲染萌语气泡 + 形状上报）。
 * **飞位动画由主进程 ball-animation 域编排**，本域只做 UI 响应，不自行移动窗口（§7.6.6 分工）。
 *
 * 兼容性：bridge 的 settings 段由并行实现提供（旧 preload 无此段）——
 * 所有调用一律可选链容错（先例：modules/teaching/index.ts 的 `teaching?.onState?.`）。
 */
import { getPetBridge } from '../../shared/pet-bridge'

export { default as SettingsGuideBubble } from './SettingsGuideBubble'

/** dev 态日志（转发到主进程日志，便于无 devtools 验证）；生产构建自动剔除 */
const devLog = (msg: string): void => {
  if (import.meta.env.DEV) console.log(`[settings-guide] ${msg}`)
}

/** 向导进行中（opened → true；saved/closed → false） */
let guideActive = false
const subscribers = new Set<(active: boolean) => void>()

function setGuideActive(next: boolean): void {
  if (next === guideActive) return
  guideActive = next
  for (const cb of [...subscribers]) {
    try {
      cb(next)
    } catch (err) {
      console.error('[settings-guide] 订阅者抛错：', err)
    }
  }
}

/** 订阅"向导进行中"（App：面板收起 + 气泡显隐）；返回取消订阅函数 */
export function subscribeSettingsGuide(cb: (active: boolean) => void): () => void {
  subscribers.add(cb)
  return () => {
    subscribers.delete(cb)
  }
}

/**
 * 宠物面接线（App 挂载时调用一次；返回清理函数）。
 * StrictMode 双调用安全：重复 setup 会替换旧订阅。
 */
export function setupSettingsGuidePetSide(): () => void {
  const off = getPetBridge().settings?.onVisibility?.((payload) => {
    const active = payload?.phase === 'opened'
    devLog(`onVisibility → phase=${payload?.phase ?? '-'} active=${active}`)
    setGuideActive(active)
  })
  return () => off?.()
}
