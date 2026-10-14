/**
 * voice 域接线（设计文档 §5.5：各业务域自行订阅 WS 事件）：
 *   WsClient `audio`（§3.5 二进制帧）→ VoicePlayer.enqueue
 *   WsClient `reply_start` → 清上一轮残留帧（防御迟到帧）
 *   WsClient `reply_end{interrupted}` → 立即停播 + 清队列 + 闭嘴（§7.2 打断时序）
 * 另提供三件对外能力：说话中状态订阅（状态栏提示）、本地立即停止（停止按钮）、dev 调试测试音。
 *
 * 幂等约定：`setupVoice` 每次调用创建独立接线并返回 cleanup（App 的 effect 卸载/StrictMode 双调用安全），
 * 模块级只保留"最近一次接线"的引用供停止按钮/调试使用。
 */
import type { WsClient } from '../../shared/ws-client'
import { setPetMouth } from '../pet'
import { VoicePlayer } from './player'
import { makeDebugVoiceFrame } from './debug'

/** "说话中"状态订阅者（App 状态栏"🔊 说话中"） */
const speakingSubscribers = new Set<(speaking: boolean) => void>()

function publishSpeaking(speaking: boolean): void {
  for (const cb of speakingSubscribers) {
    try {
      cb(speaking)
    } catch (err) {
      console.error('[voice] 说话状态订阅者抛错：', err)
    }
  }
}

/** 订阅本地播放状态（说话中/待机）；返回取消订阅函数 */
export function subscribeVoiceSpeaking(cb: (speaking: boolean) => void): () => void {
  speakingSubscribers.add(cb)
  return () => {
    speakingSubscribers.delete(cb)
  }
}

/** 最近一次接线的播放器（停止按钮本地立即停 / 调试自测用） */
let activePlayer: VoicePlayer | null = null

/** 本地立即停止播放并清空队列（停止按钮点击时；后端 reply_end{interrupted} 到达时会再次清理，幂等） */
export function stopVoiceNow(reason = '用户点击停止'): void {
  activePlayer?.stopAll(reason)
}

/** dev 调试：把合成测试音作为一帧入队，走完整播放链路（验证声音/口型/清理） */
export function playDebugTone(): void {
  if (!activePlayer) {
    console.warn('[voice] 调试测试音：播放器未接线（setupVoice 未执行？）')
    return
  }
  activePlayer.enqueue(makeDebugVoiceFrame())
  console.log('[voice] 调试测试音已入队（合成 WAV 1.6s；应能听到"说话感"音高起伏且口型开合）')
}

/** dev 调试钩子：控制台可用 window.__petVoiceDebug（生产构建剔除） */
export function installVoiceDebugHook(): void {
  if (!import.meta.env.DEV) return
  ;(window as unknown as { __petVoiceDebug?: unknown }).__petVoiceDebug = {
    playTone: playDebugTone,
    stop: (): void => stopVoiceNow('调试停止'),
    isSpeaking: (): boolean => activePlayer?.isSpeaking ?? false
  }
  console.log('[voice] 调试钩子已挂载：window.__petVoiceDebug（playTone/stop/isSpeaking）')
}

/**
 * 建立 voice 接线；返回 cleanup（注销事件订阅 + 释放播放器）。
 * 调用点：App 根部 effect（订阅 wsClient 的音频帧与回复生命周期）。
 */
export function setupVoice(client: WsClient): () => void {
  const player = new VoicePlayer({
    onLevel: (level) => setPetMouth(level), // 口型：经 pet 域控制器转发到当前渲染器
    onSpeakingChange: publishSpeaking
  })
  activePlayer = player

  const offs = [
    client.on('audio', (packet) => player.enqueue(packet)),
    client.on('reply_start', ({ message_id }) => player.dropOtherMessages(message_id)),
    client.on('reply_end', ({ message_id, interrupted }) => {
      if (interrupted) player.stopAll(`reply_end{interrupted} msg=${message_id}`)
    })
  ]
  console.log('[voice] 接线完成（audio → 播放队列；reply_start 清残留；reply_end{interrupted} 打断）')

  return () => {
    offs.forEach((off) => off())
    if (activePlayer === player) activePlayer = null
    player.dispose()
    console.log('[voice] 接线已清理')
  }
}
