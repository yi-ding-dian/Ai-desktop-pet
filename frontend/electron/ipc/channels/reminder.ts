// ------------------------------------------------------------------ 提醒列表（reminder-list 域）

/** 列表视图：unread=未读列表；today=时钟入口（当天事件 + 未到期计划） */
export type ReminderListMode = 'unread' | 'today'

/** 宠物窗 → 主：提醒列表快照（items 为空/visible=false 时主进程隐藏列表窗） */
export interface ReminderListUpdatePayload {
  mode: ReminderListMode
  items: ReminderListItemPayload[]
  /** 徽标数字：unread 模式=未读总数；today 模式=事件 + 未到期计划总数 */
  unreadCount: number
  /** 尚未到期的计划（灰灯；底部灰灯展开时按到期时间正序显示） */
  pendingItems: ReminderListItemPayload[]
  /** 底部灰灯是否已展开（仅 unread 模式有意义） */
  pendingExpanded: boolean
  /** 尚未到期的提醒数（列表底部“未到时间 N 条”入口；2026-10-18） */
  pendingCount: number
  /** true = 没有任何未读、只有待提醒：常驻显示一个灰色铃铛小球（点击展开） */
  bellOnly: boolean
  visible: boolean
}

/** 列表项（只带展示所需字段；已触发事件 id = reminder_events.id，pending 项 id = reminders.id） */
export interface ReminderListItemPayload {
  id: string
  text: string
  timeText: string
  late: boolean
  acknowledged: boolean
  /** true = 未到期（灰灯；不可点击标记已读） */
  pending: boolean
}

/** 主 → 列表窗：内容与形态（compact = 两侧空间都不够时的"待看 N 条"小条） */
export interface ReminderListOpenPayload {
  mode: ReminderListMode
  items: ReminderListItemPayload[]
  unreadCount: number
  pendingItems: ReminderListItemPayload[]
  pendingExpanded: boolean
  pendingCount: number
  bellOnly: boolean
  /** 灰灯在宠物哪一侧（渲染侧据此把内容贴向宠物：右侧左对齐 / 左侧右对齐） */
  bellSide: 'right' | 'left'
  compact: boolean
}

/** 列表窗 → 主：用户动作（展开小条 / 单条已读 / 全部已读 / 切换视图 / 灰灯展开收起 / 删除） */
export interface ReminderListActionPayload {
  type:
    | 'expand'
    | 'ack'
    | 'ack-all'
    | 'history'
    | 'unread'
    | 'pending-expand'
    | 'pending-collapse'
    | 'delete'
  id?: string
}
