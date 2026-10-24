/** 动画域共享状态：流程与兜底外壳都要读写的少量字段。 */
import type { Rect } from '../window'

export const ballState: {
  /** 动画锁：true = 有动画进行中（期间新的显/隐请求直接忽略） */
  busy: boolean
  /** 宠物隐藏前的"家"（显示动画归位用；隐藏动画开始时记录） */
  stashedBounds: Rect | null
} = {
  busy: false,
  stashedBounds: null
}
