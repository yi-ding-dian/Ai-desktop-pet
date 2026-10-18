/**
 * chat 域入口（对话）：输入行组件 + 说话气泡驱动 + 会话记录 + 情绪映射。
 * 域外（App/其它域）只经本入口通信——域内实现（ChatPanel/speech/history/emotions）不直接暴露路径依赖。
 */
export { default as ChatPanel } from './ChatPanel'
export {
  setupSpeechBubble,
  dismissSpeechBubble,
  speakLocalNotice,
  speakReminder,
  speakLifecycleLine,
  type SpeechBubbleOptions
} from './speech'
export { setupChatHistory, getChatHistory, clearChatHistory, type ChatRecord } from './history'
export { emotionEmoji } from './emotions'
export {
  showChatNotice,
  clearChatNotice,
  subscribeChatNotice,
  type ChatNotice
} from './notice'
