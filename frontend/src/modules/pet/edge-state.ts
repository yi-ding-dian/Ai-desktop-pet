/**
 * 贴边吸附保持状态（2026-10-20）。
 *
 * 背景：宠物吸附到屏幕边缘后，后端自主行为（walk/nap/look_around）仍会下发，
 * walk 会把窗口带走（用户看到"吸附后还左右移动"），nap 还会让边缘动作让位。
 *
 * 规则：
 * - 用户拖拽松手时若处于贴边状态 → `lockPetEdgeSnap()` 锁定；
 * - 锁定期间行为执行器跳过所有自主行为（立即回报 interrupted，引擎照常记账/冷却）；
 * - 窗口离开所有边缘（edge → none）自动解锁，恢复自主行为；
 * - 自主走动经过边缘不算锁定（没有用户松手动作）——只短暂显示边缘动作，不打断走动。
 */
import type { PetWindowEdge } from '../../../electron/ipc/channels'

/** 主进程贴边状态镜像（PetView 收到 onEdgeChanged 时更新） */
let currentEdge: PetWindowEdge = 'none'
/** 用户拖拽松手造成的吸附保持 */
let snapLocked = false

export function setPetWindowEdge(edge: PetWindowEdge): void {
  currentEdge = edge
  if (edge === 'none') snapLocked = false
}

/** 用户在贴边状态松手时调用（吸附保持开始） */
export function lockPetEdgeSnap(): void {
  if (currentEdge !== 'none') snapLocked = true
}

export function isPetEdgeSnapLocked(): boolean {
  return snapLocked
}
