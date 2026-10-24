/** 魔法球动画与生命周期台词的载荷。 */

/**
 * fx 动画指令（主进程为指挥，fx 球窗页面只负责"画"；球固定在球窗中心，
 * 飞行 = 主进程移动球窗本身——指令不需要坐标，只有表现状态）。
 */
export type BallAnimationCommand =
  | { type: 'reset' }
  /** 原地凝聚显现：球体在窗口中心从无到有（光点渐入 + 微脉动），durationMs 由主进程计时——到点发下一条指令 */
  | { type: 'spawn'; durationMs: number }
  /** 进入飞行表现（拖尾/公转星点；cargo=true 时球内载宠物剪影——去程空载、回程携带） */
  | { type: 'flight'; cargo: boolean }
  /** 捕获爆闪：球心爆闪并吸附脉动（球窗原地停留 holdMs，期间宠物窗口缩小） */
  | { type: 'capture-burst'; holdMs: number }
  /** 释放爆闪：球炸开、光芒散开（显示方向） */
  | { type: 'release-burst' }
  /** 整层淡出（durationMs 后主进程隐藏球窗） */
  | { type: 'fade-out'; durationMs: number }

/** 宠物反应事件载荷（主 → 宠物窗口渲染进程） */
export interface BallAnimationPetReactionPayload {
  /** captured = 被魔法球抓住（隐藏动画）；released = 被放回原位（显示动画） */
  kind: 'captured' | 'released'
}

/**
 * 生命周期台词载荷（主 → 宠物窗口渲染进程，2026-10-18）：
 * 启动落地后说"我来了~"、退出捕获前说"再见啦~"——**本地固定文案**，不经过后端 LLM/TTS。
 * 时序完全由主进程（ball-animation 域）编排，渲染侧只负责经说话气泡展示。
 */
export interface PetSayLinePayload {
  /** 台词正文（本地固定文案） */
  text: string
  /** 气泡停留时长（ms；主进程按退出流程的等待时长给出） */
  ttlMs: number
  /** greeting = 启动问候；farewell = 退出告别（强制展示：正在流式回复也会被打断让位） */
  kind: 'greeting' | 'farewell'
}
