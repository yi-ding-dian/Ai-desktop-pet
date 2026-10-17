/**
 * 窗口移动锁（平台无关的模块级开关）——魔法球动画（ball-animation 域）在播放期间置位，
 * 阻止用户拖拽 / 自主行为 moveTo 与动画的逐帧 setBounds 抢窗口控制权。
 *
 * 为什么需要（2026-10-17 真机 bug）：隐藏/显示动画会把宠物窗从 400×400 缩到 0.2×
 * （releasePetAt 先以缩小态 show，再在 releaseMs 内放大归位）。如果用户在这段时间拖动宠物
 * 或自主行为 walk 恰好开始：
 *  - 拖拽的 dragOrigin 会以**缩小后的 bounds**为基准，之后的 dragMove 把窗口一直设回小尺寸；
 *  - moveTo 缓动器在启动时快照当前（小）尺寸，同样会保持小窗。
 * 动画结束后，宠物窗口停在 ~100×100，渲染画布（208×208）被裁到只剩兔头一块——用户反馈
 * “有时只显示一点兔头，身体不见了”。
 *
 * 语义：锁只拦**外部移动源**（拖拽 / moveTo / setScale 之外的窗口移动），不拦动画自身的
 * setBounds；动画结束（含异常/超时）必须在 finally 里解锁。
 */
let locked = false

/** 置位/清除移动锁（幂等）。 */
export function setWindowMoveLock(next: boolean): void {
  locked = next
}

/** 当前是否处于动画移动锁定期。 */
export function isWindowMoveLocked(): boolean {
  return locked
}
