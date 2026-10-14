/**
 * pet-bridge：渲染进程访问主进程能力的唯一封装（设计文档 §2.2 src/shared/pet-bridge）。
 *
 * 渲染侧不感知 IPC 通道细节，只调用 preload 注入的 window.pet 白名单 API。
 */
import type { PetBridgeApi } from '../../../electron/ipc/channels'

declare global {
  interface Window {
    pet: PetBridgeApi
  }
}

/** 获取 pet bridge；preload 未注入时给出明确报错（便于定位） */
export function getPetBridge(): PetBridgeApi {
  const bridge = window.pet
  if (!bridge) {
    throw new Error('[pet-bridge] window.pet 未注入：preload 加载失败？')
  }
  return bridge
}
