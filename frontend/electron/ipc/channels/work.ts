// ------------------------------------------------------------------ 工作模式（2026-10-18）

/** 联网搜索来源（工作窗引用悬浮卡片；与后端 SourceItemData 对齐） */
export interface WorkSourceItem {
  index: number
  title: string
  url: string
  snippet: string
  site_name: string
  date: string
}

/** 工作窗单轮选项（与后端 UserMessageOptions 对齐） */
export interface WorkTurnOptions {
  /** 智能搜索：false = 本轮不提供 web_search / web_fetch */
  search: boolean
}

/** 工作窗发送请求（工作窗 → 主 → 宠物窗） */
export interface WorkSendRequestPayload {
  requestId: string
  text: string
  attachments: { path: string; name: string }[]
  options: WorkTurnOptions
  /** 目标对话 id；缺省 = 当前连接会话（旧客户端兼容） */
  sessionId?: string
}

/** 发送结果（宠物窗 → 主 → invoke 回执） */
export interface WorkSendResultPayload {
  requestId: string
  ok: boolean
  reason?: string
}

/** 对话镜像事件（宠物窗 → 主 → 工作窗） */
export type WorkMirrorEvent =
  | { kind: 'user_message'; localId: string; text: string; sentAt: number; sessionId?: string }
  | { kind: 'reply_start'; messageId: string; sessionId?: string }
  | {
      kind: 'message_saved'
      clientId: string
      dbId: number
      role: string
      sessionId?: string
    }
  | { kind: 'message_deleted'; dbId: number; ok: boolean; sessionId?: string }
  | { kind: 'sources'; messageId: string; items: WorkSourceItem[]; sessionId?: string }
  | { kind: 'reasoning'; messageId: string; text: string; sessionId?: string }
  | { kind: 'token'; messageId: string; text: string; sessionId?: string }
  | {
      kind: 'reply_end'
      messageId: string
      fullText: string
      interrupted: boolean
      sessionId?: string
    }
  | { kind: 'state'; state: string; sessionId?: string }
  | {
      kind: 'emotion'
      messageId: string
      emotion: string
      intensity: number
      sessionId?: string
    }
  | { kind: 'notice'; code: string; message: string; level?: string; sessionId?: string }

/** 历史消息（后端 messages 表行） */
export interface WorkHistoryMessage {
  id: number | string
  role: string
  content: string
  created_at?: number
  emotion?: string | null
}

/** 历史请求载荷（sessionId 省略 = 当前连接会话） */
export interface WorkHistoryRequestPayload {
  requestId: string
  limit?: number
  sessionId?: string
}

/** 历史响应（宠物窗 → 主 → invoke 回执） */
export interface WorkHistoryPayload {
  requestId: string
  ok: boolean
  reason?: string
  /** 本次历史所属对话（宠物面回填；旧路径缺省） */
  sessionId?: string
  messages: WorkHistoryMessage[]
  /** 发请求后缓冲的镜像事件（按序合并，避免与历史重复/丢失） */
  bufferedEvents: WorkMirrorEvent[]
  /** 正在流式的助手消息快照（中途打开工作窗时续上） */
  live?: {
    messageId: string
    text: string
    reasoning: string
    startedAt: number
  }
}

// ------------------------------------------------------------------ 对话列表（2026-10-24）

/** 对话列表的一行（后端 sessions 表 + 首条消息兜底标题） */
export interface WorkConversationSummary {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  messageCount: number
  /** 'pet' = 固定的宠物会话（置顶、不可改名/删除） */
  kind: 'pet' | 'chat'
}

export interface WorkConversationsRequestPayload {
  requestId: string
}

export interface WorkConversationsPayload {
  requestId: string
  ok: boolean
  reason?: string
  items: WorkConversationSummary[]
}

export interface WorkRenameConversationRequestPayload {
  requestId: string
  id: string
  title: string
}

export interface WorkConversationRenamedPayload {
  requestId: string
  id: string
  ok: boolean
  title?: string
  reason?: string
}

export interface WorkDeleteConversationRequestPayload {
  requestId: string
  id: string
}

export interface WorkConversationDeletedPayload {
  requestId: string
  id: string
  ok: boolean
  reason?: string
}

/** 工作窗状态（主 → 宠物窗） */
export interface WorkPresencePayload {
  /** 窗口是否存在（决定是否镜像对话；隐藏期间仍为 true） */
  open: boolean
  /** 是否正在工作（窗口可见且未最小化）——宠物依附/自主行为抑制的依据 */
  active: boolean
}

// ------------------------------------------------------------------ 工作模式内嵌浏览器（2026-10-18）

/** 内嵌浏览器标签（渲染面展示用；WebContentsView 只在主进程持有） */
export interface WorkBrowserTab {
  id: string
  title: string
  url: string
  loading: boolean
  /** 加载失败说明（成功时为 undefined） */
  error?: string
}

/** 内嵌浏览器状态（主 → 工作窗） */
export interface WorkBrowserState {
  tabs: WorkBrowserTab[]
  /** 当前激活标签；null = 对话 */
  activeId: string | null
  canGoBack: boolean
  canGoForward: boolean
}

/** 工作窗 → 主：打开链接 */
export interface WorkBrowserOpenPayload {
  url: string
  /** 初始标签名（取不到时用域名）；加载后会被页面标题覆盖 */
  label?: string
}

/** 工作窗 → 主：浏览器工具条动作 */
export type WorkBrowserAction = 'back' | 'forward' | 'reload' | 'external'

/** 标题栏高度（与套件 .pui-titlebar 对齐；WebContentsView 的 top 计算用） */
export const WORK_TITLEBAR_HEIGHT = 40
/** 浏览器工具条高度（与 work.css .work-browser-bar 对齐） */
export const WORK_BROWSER_TOOLBAR_HEIGHT = 34
/** 网页视图四周边距：露出窗口圆角 + 保留四边缩放热区 */
export const WORK_BROWSER_INSET = 8
