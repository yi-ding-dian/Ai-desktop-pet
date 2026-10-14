/**
 * voice 域出口（设计文档 §2.2）：TTS 音频播放（队列/口型/打断）。
 * 对外最小面：App 只依赖 setupVoice 与状态订阅、停止、调试入口；
 * 队列/播放器/口型驱动为域内实现，测试可直接引用域内文件（白盒）。
 */
export {
  setupVoice,
  subscribeVoiceSpeaking,
  stopVoiceNow,
  playDebugTone,
  installVoiceDebugHook
} from './setup'
export type { VoicePlayer, VoicePlayerOptions, MouthDriverLike } from './player'
