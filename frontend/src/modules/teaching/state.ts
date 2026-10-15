/**
 * 教学模式本地状态（P5 §7.5）：模块级单例，零依赖。
 *
 * 为什么单独成文件：pet 域行为执行器（behaviors/executor.ts）需要读取"当前是否教学模式"
 * 来做行为指令防御；若直接依赖 teaching/index.ts 会形成 teaching ↔ pet 的循环依赖。
 *
 * 主进程为权威状态源；本模块只是主进程 onState 广播的本地镜像（由 setupTeachingPetSide 维护）。
 */

let teachingMode = false

/** 更新本地教学模式标记（teaching 域内部维护；其余模块只读） */
export function setTeachingModeLocal(on: boolean): void {
  teachingMode = on
}

/** 当前是否处于教学模式（pet 域行为执行器防御读取；主进程未接线的旧 preload 下恒为 false） */
export function isTeachingMode(): boolean {
  return teachingMode
}
