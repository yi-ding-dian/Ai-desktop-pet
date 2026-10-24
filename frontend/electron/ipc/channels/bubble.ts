/** 气泡系统载荷。 */

/** 尾巴朝向：down = 尾巴在气泡左下角（气泡悬于锚点上方，指向下方的宠物）；up = 翻向（气泡在锚点下方） */
export type BubbleTail = 'down' | 'up'

/**
 * 运动预设：
 *  - hand = 手来手回（小光点从爪子方向飞入展开 / 退场收回——右键菜单、清空确认用）；
 *  - light = 轻量展开（气泡自尾巴处弹性绽放 / 收拢淡出，无光点——说话气泡用，高频不闹）；
 *  - none = 直接显隐（预留）。
 */
export type BubbleMotion = {
  enter: 'hand' | 'light' | 'none' | 'instant'
  exit: 'hand' | 'light' | 'none' | 'instant'
}

/** 气泡形态预设（menu = 右键菜单；confirm = 清空确认；text = 说话气泡——聊天回复展示在兔子头部旁） */
export type BubbleVariant = 'menu' | 'confirm' | 'text'

/** 菜单项载荷（icon = shared/icons 的图标名——'teaching' | 'settings' | 'broom' | 'sleep'；未知名渲染为无图标） */
export interface BubbleMenuItemPayload {
  id: string
  label: string
  icon?: string
}

/**
 * 气泡打开载荷（主 → 气泡窗）。
 * session：弹出会话序号（主进程递增）——主进程在 show 后延迟补发同载荷一次（防 React 订阅前丢首帧），
 * 渲染侧按 session 去重（重复只认不重播动画）。tail 由主进程定位计算给出（防出屏翻向）。
 */
export type BubbleOpenPayload = {
  session: number
  tail: BubbleTail
  motion: BubbleMotion
  /**
   * 窗口是否复用（Windows 策略）：true = 跳过"尺寸稳定 → 强制重绘重挂载"。
   * 该重挂载是 Linux/KWin 残屏的补偿；在复用窗口上会在入场动画约 320ms 处再重渲染一次，
   * 观感像"分两段弹出"（2026-10-17 用户反馈）。
   */
  stableWindow?: boolean
} & (
  | { variant: 'menu'; items: BubbleMenuItemPayload[] }
  | { variant: 'confirm'; message: string; confirmLabel: string; cancelLabel: string }
  | { variant: 'text'; message: string; meta?: BubbleSpeechMeta }
)

/** 气泡请求（渲染面 → 主）：本期只有宠物窗右键菜单一种入口 */
export type BubbleRequest = {
  kind: 'menu'
  /** 右键发生点的屏幕坐标（DIP）；用于"右键实际落到宠物窗但点在气泡上"的兜底判定 */
  x?: number
  y?: number
}

/** 说话气泡文本快照载荷（宠物面 → 主；全文覆盖式更新——渲染侧已节流，主进程转发气泡窗） */
export interface BubbleSayTextPayload {
  text: string
}

/**
 * 说话气泡的消息属性（2026-10-18）：让气泡窗知道"这条是不是提醒"。
 * 提醒气泡会显示「知道了」按钮；点它 → 主进程回传 reminder-ack → 宠物面发 ack_reminders。
 */
export interface BubbleSpeechMeta {
  kind: 'chat' | 'reminder'
  /** 回复/提醒消息 id（提醒批次用 batch_id） */
  messageId?: string
  /** 提醒批次 id（proactive.batch_id） */
  batchId?: string
  /** 本批提醒的事件 id（reminder_events.id；"知道了"按它回执） */
  eventIds?: string[]
}

/** 说话气泡开始载荷（宠物面 → 主）：meta 决定气泡形态（普通回复 / 提醒） */
export interface BubbleSayBeginPayload {
  meta?: BubbleSpeechMeta
}

/** 说话气泡结束载荷（宠物面 → 主）：immediate = 被打断，不等停留立即收 */
export interface BubbleSayEndPayload {
  immediate?: boolean
}

/** 主 → 宠物窗：提醒气泡生命周期（关闭 = 未读进列表；reminder-ack = 已读回执） */
export interface BubbleSpeechEventPayload {
  type: 'closed' | 'reminder-ack'
  meta: BubbleSpeechMeta
  /** closed 的原因（日志/排障）：idle / replaced / user / teaching / settings / menu 等 */
  reason?: string
}

/** 同 session 内容更新载荷（主 → 气泡窗；说话气泡流式刷新——只换文字不重播入场，尺寸变化由既有 REPORT_SIZE 链路重摆） */
export interface BubbleUpdatePayload {
  session: number
  message: string
  /** 消息属性（提醒/回复切换时同步，决定是否显示「知道了」） */
  meta?: BubbleSpeechMeta
}
