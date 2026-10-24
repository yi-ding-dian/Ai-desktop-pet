/** 气泡域的尺寸、时延与动作白名单常量。 */
import type { Point, Size } from '../window'

/**
 * 兔子头部锚点偏移（宠物窗内坐标）：气泡从兔子头右上方展开、尾巴朝左下指向兔子头——
 * 窗口 270×240（2026-10-20）、兔子视觉范围约 x 15–255 / y 0–208，锚点取右侧头肩一带。
 * 画布 top 从 34 改为 0，锚点 y 同步 92→58；宽度 320→270，锚点 x 215→190。
 */
export const HEAD_ANCHOR_OFFSET: Point = { x: 190, y: 58 }

/**
 * 各形态预估尺寸（px；show 前先用它定位——真实尺寸经 REPORT_SIZE 收紧重定位）。
 * 与渲染侧 bubble.css 的内容尺寸大致对齐（宁大勿小：大了透明区稍多，小了内容被裁）。
 */
export const ESTIMATED_SIZE: Record<'menu' | 'confirm' | 'text', Size> = {
  menu: { width: 216, height: 206 },
  confirm: { width: 236, height: 178 },
  text: { width: 370, height: 218 }
}

/** 宠物移动跟随节流（ms）：拖动/走动时 petWin 'move' 高频触发，至多每 16ms 重摆一次气泡窗 */
export const FOLLOW_THROTTLE_MS = 16

/** 内容尺寸收敛范围（setBounds 用；下限防零尺寸，上限防极端长文本撑爆窗口） */
export const MIN_SIZE: Size = { width: 120, height: 60 }
export const MAX_SIZE: Size = { width: 420, height: 420 }

/** 等待气泡页就绪超时（ms） */
export const READY_TIMEOUT_MS = 2500
/** show 后延迟补发内容（ms）：did-finish-load 早于 React 订阅建立时首帧可能丢失的兜底 */
export const OPEN_REPOST_MS = 150
/** 退场回报超时（ms）：渲染侧播完退场未回报 CLOSED 时强制 hide 兜底 */
export const CLOSE_TIMEOUT_MS = 700
/** 确认气泡无人操作自动取消的时长（ms） */
export const CONFIRM_TIMEOUT_MS = 120_000

/** 菜单动作 id 白名单（防渲染面误发/脏数据） */
export const MENU_ACTION_IDS: readonly string[] = [
  'teaching',
  'work',
  'settings',
  'clear-chat',
  'hide-pet'
]
/** 确认气泡动作 id 白名单（PetBubble 组件的通用语义 id：确认/取消） */
export const CONFIRM_ACTION_IDS: readonly string[] = ['confirm', 'cancel']
/** 说话气泡动作 id 白名单（悬浮工具条：expand=打开工作模式；close=收气泡；reminder-ack=提醒已读） */
export const SPEECH_ACTION_IDS: readonly string[] = ['expand', 'close', 'reminder-ack']

/** 清空确认文案（用户定稿场景2；确认动作本期只发事件，清空逻辑归后续任务） */
export const CLEAR_CHAT_CONFIRM = {
  message: '清空全部聊天记录？',
  confirmLabel: '清空',
  cancelLabel: '取消'
} as const
