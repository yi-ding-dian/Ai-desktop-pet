/**
 * 当前前台对话（2026-10-24）：宠物气泡/语音/聊天面板只消费它的回复事件。
 *
 * 工作窗切换对话时由 work 宠物面更新，并同步给后端（conversation_focus）；
 * 后端同时用它决定是否推送 state/sentence/emotion/音频。
 */
let activeConversationId: string | undefined

export function setActiveConversationId(id: string | undefined): void {
  activeConversationId = id || undefined
}

export function getActiveConversationId(): string | undefined {
  return activeConversationId
}

/** 事件没有 session_id（旧后端/非对话事件）或未设置前台时，一律按前台处理。 */
export function isForegroundSession(sessionId?: string): boolean {
  if (!sessionId || !activeConversationId) return true
  return sessionId === activeConversationId
}
