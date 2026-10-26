/**
 * 工作模式本地状态（模块级单例，零依赖）。
 *
 * 只表示"工作窗当前可见且未最小化"（主进程 presence.active 镜像）：
 * - 行为执行器据此跳过自主行为（与教学模式的防御同款）；
 * - App 据此隐藏宠物输入框、抑制对话回复气泡；
 * - 不表示窗口是否存在（存在性用于对话镜像，隐藏时仍需继续同步）。
 *
 * 放在独立文件是为了避免 `modules/work-mode/index` → `pet/behavior` → `modules/work-mode`
 * 的循环依赖（与 teaching/state.ts 同因）。
 */

let workActive = false
const listeners = new Set<(active: boolean) => void>()

export function setWorkActiveLocal(active: boolean): void {
  if (workActive === active) return
  workActive = active
  for (const cb of [...listeners]) {
    try {
      cb(active)
    } catch (err) {
      console.error('[work] 状态订阅者抛错：', err)
    }
  }
}

export function isWorkModeActive(): boolean {
  return workActive
}

/** 订阅工作模式显隐（App 的输入框/气泡联动）；返回取消订阅函数 */
export function subscribeWorkActive(cb: (active: boolean) => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}
