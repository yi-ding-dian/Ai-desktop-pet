/** 教学模式载荷。 */
import type { Point } from '../../window'

// ------------------------------------------------------------------ 教学模式（P5，设计文档 §7.5）

/** 进入教学模式的触发来源（日志/调试用） */
export type TeachingEnterReason = 'menu' | 'keyword' | 'debug'

/** 教学模式状态（主进程为唯一权威；两渲染面只读） */
export interface TeachingStatePayload {
  mode: 'normal' | 'teaching'
  /** 仅 mode=teaching 有意义：黑板是否处于折叠（角标）态 */
  folded: boolean
  /** 讲台位目标屏幕坐标（进入/恢复教学模式时给出；宠物面据此走位） */
  podium?: Point
  /** 状态变化原因（'menu' | 'keyword' | 'drag' | 'unfold' | 'exit' | 'ready' 等，日志用） */
  reason?: string
}

/**
 * 黑板输入条发送载荷（黑板 → 主 → 宠物面）：
 * 附件只传路径与显示名，正文由后端在本机读取（与聊天输入框/工作窗同款）。
 */
export interface TeachingSendRequestPayload {
  text: string
  attachments: { path: string; name: string }[]
}

/**
 * 镜像事件（宠物面 → 主 → 黑板面）：
 * 对话主体仍在宠物窗口的 WS 连接上，黑板是"哑显示"——宠物面收到这些事件后镜像一份。
 */
export type TeachingMirrorEvent =
  | { kind: 'user_message'; text: string }
  | { kind: 'reply_start'; messageId: string }
  | { kind: 'token'; messageId: string; text: string }
  | { kind: 'reply_end'; messageId: string; fullText: string; interrupted: boolean }
  | { kind: 'history'; messages: { id: string; role: 'user' | 'assistant'; text: string }[] }

/** 黑板收件箱指令（主 → 黑板面；单通道多指令） */
export type TeachingBoardInbox =
  | { type: 'mirror'; event: TeachingMirrorEvent }
  | { type: 'goto'; messageId: string }
  /** expand = 卷出恢复；fold = 折叠成角标；exit = 退出教学模式（滑出收起） */
  | { type: 'visibility'; action: 'expand' | 'fold' | 'exit' }
