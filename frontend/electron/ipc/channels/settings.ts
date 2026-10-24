// ------------------------------------------------------------------ 设置向导宠物（P4，设计文档 §7.6.6）与自绘托盘菜单（§7.6.4）

/** 设置窗显示状态（主 → 宠物窗；驱动向导 UI——飞位动画由主进程 ball-animation 域编排，宠物面只做响应） */
export type SettingsVisibilityPhase = 'opened' | 'saved' | 'closed'

/** SETTINGS_VISIBILITY 推送载荷 */
export interface SettingsVisibilityPayload {
  /** opened = 设置窗打开（宠物已飞至向导位：收起面板+萌语气泡）；saved/closed = 已触发飞回原位（气泡收起+面板恢复） */
  phase: SettingsVisibilityPhase
}

/** 自绘托盘菜单项动作（菜单窗 → 主；主进程执行后收起菜单窗） */
export type TrayMenuAction =
  | 'toggle-pet'
  | 'teaching'
  | 'work'
  | 'settings'
  | 'quit'
