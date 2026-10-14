/**
 * 语音播放器（设计文档 §4.4 前端侧）：播放队列 + 口型驱动 + 打断支持。
 *
 * 帧流：WsClient `audio` 事件（§3.5 二进制帧）→ enqueue → 顺序播放
 *（同一时刻只有一个 HTMLAudioElement 在播；队列空 → 待机 + 闭嘴）。
 * 播放：Blob(mp3) → URL.createObjectURL → HTMLAudioElement；
 * 正常结束 / 出错 / 被停止都会释放 ObjectURL 与元素资源。
 * 容错：设备无音频 / play() 被拒 → 记日志并继续下一帧（不崩、不卡队列）。
 * 口型：元素 `playing` 后接入 MouthDriver（Web Audio 包络 → onLevel → 接线层转发 setMouth）。
 */
import type { AudioFramePacket } from '../../shared/protocol'
import { AudioQueue } from './audio-queue'
import { MouthDriver } from './lipsync'
import { shortId } from './util'

/** 口型驱动最小接口（测试可注入替身） */
export interface MouthDriverLike {
  attach(el: HTMLAudioElement): boolean
  detach(): void
  dispose?(): void
}

export interface VoicePlayerOptions {
  /** 口型输出（每帧包络 0–1，由接线层注入 pet 域 setMouth） */
  onLevel: (level: number) => void
  /** 播放状态变化：true = 进入说话中，false = 队列排空回待机（UI "🔊 说话中"提示） */
  onSpeakingChange?: (speaking: boolean) => void
  /** 口型驱动（缺省 MouthDriver；测试注入用） */
  mouth?: MouthDriverLike
}

/** 音频 format → Blob MIME（mp3 为正式格式；wav 仅调试自测入口使用） */
function formatToMime(format: string): string {
  switch (format) {
    case 'wav':
      return 'audio/wav'
    case 'mp3':
    default:
      return 'audio/mpeg'
  }
}

export class VoicePlayer {
  private readonly queue = new AudioQueue()
  private readonly mouth: MouthDriverLike
  private readonly onSpeakingChange?: (speaking: boolean) => void

  /** 当前播放元素 / 配对 ObjectURL / 当前帧清理函数（未播放时均为 null） */
  private audio: HTMLAudioElement | null = null
  private currentCleanup: (() => void) | null = null
  /** 当前播放帧所属 message_id（防御清残留时判断新旧） */
  private currentMessageId: string | null = null
  private playing = false
  private speaking = false
  private disposed = false

  constructor(options: VoicePlayerOptions) {
    this.mouth = options.mouth ?? new MouthDriver(options.onLevel)
    this.onSpeakingChange = options.onSpeakingChange
  }

  /** 是否处于说话中（本地播放状态） */
  get isSpeaking(): boolean {
    return this.speaking
  }

  /** 入队一帧并尝试开始播放（播放中入队 = 续播到该帧） */
  enqueue(packet: AudioFramePacket): void {
    if (this.disposed) return
    this.queue.enqueue(packet)
    const { message_id, seq, format, final } = packet.header
    console.log(
      `[voice] 帧入队 msg=${shortId(message_id)} seq=${seq} format=${format} bytes=${packet.payload.byteLength} final=${final} 队列=${this.queue.size}`
    )
    this.playNext()
  }

  /**
   * 停止当前播放并清空队列（打断；幂等）。
   * 调用点：reply_end{interrupted}、点击"停止"（本地立即静音）。
   */
  stopAll(reason: string): void {
    const hadWork = this.playing || !this.queue.isEmpty
    this.queue.clear()
    this.stopCurrentAudio()
    this.setSpeaking(false) // 打断后立即回到待机（"🔊 说话中"状态与停止按钮显示依赖此状态）
    if (hadWork) console.log(`[voice] 停止：清空播放与队列（${reason}）`)
  }

  /**
   * 丢弃指定 message_id 之外的残留帧（收到新 reply_start 时防御迟到帧）。
   * 当前播放帧若属于旧消息（上一轮残留还在播）→ 立即停并推进新队列。
   */
  dropOtherMessages(messageId: string): void {
    const dropped = this.queue.clearExcept(messageId)
    const stoppedOld = this.audio !== null && this.currentMessageId !== messageId
    if (stoppedOld) this.stopCurrentAudio()
    if (dropped > 0 || stoppedOld) {
      console.log(`[voice] 清理上一轮残留：丢弃帧 ×${dropped}${stoppedOld ? '，停止旧帧播放' : ''}`)
    }
    if (stoppedOld) this.playNext()
  }

  /** 彻底释放（接线层 cleanup 调用）：清队列 + 停播 + 释放口型驱动 */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.queue.clear()
    this.stopCurrentAudio()
    this.mouth.dispose?.()
  }

  // ---------------- 内部 ----------------

  /** 取下一帧开始播放；播放中/已释放则忽略 */
  private playNext(): void {
    if (this.disposed || this.playing) return
    const packet = this.queue.dequeue()
    if (!packet) {
      this.setSpeaking(false) // 队列空 → 待机（finish 已处理，这里兜底）
      return
    }
    this.startPlayback(packet)
  }

  /** 启动一帧的播放（Blob → ObjectURL → Audio → mouth 接入 → 结束推进） */
  private startPlayback(packet: AudioFramePacket): void {
    const { message_id, seq, format } = packet.header
    const blob = new Blob([packet.payload], { type: formatToMime(format) })
    const url = URL.createObjectURL(blob)
    const audio = new Audio(url)

    this.audio = audio
    this.playing = true
    this.currentMessageId = message_id
    this.setSpeaking(true)

    /** 释放元素与 ObjectURL（先移除监听，防清理动作再触发回调） */
    const cleanupElement = (): void => {
      audio.removeEventListener('playing', onPlaying)
      audio.removeEventListener('ended', onEnded)
      audio.removeEventListener('error', onError)
      try {
        audio.pause()
        audio.removeAttribute('src') // 断开底层媒体资源引用
      } catch {
        /* 元素已失效 */
      }
      URL.revokeObjectURL(url)
    }

    const onPlaying = (): void => {
      console.log(`[voice] playing msg=${shortId(message_id)} seq=${seq}`)
      // 真正出声时接入口型（Web Audio 连接到扬声器输出）
      this.mouth.attach(audio)
    }
    const onEnded = (): void => finish('ended')
    const onError = (): void => finish('error')

    const finish = (reason: 'ended' | 'error' | 'play-rejected'): void => {
      if (this.audio !== audio) return // 已被 stopCurrentAudio 作废（双保险）
      this.audio = null
      this.currentCleanup = null
      this.currentMessageId = null
      this.playing = false
      cleanupElement()
      this.mouth.detach() // 停止播放即闭嘴（setMouth(0)）
      if (reason !== 'ended') {
        console.warn(`[voice] 本帧未正常结束（${reason}），按约定继续下一帧`)
      }
      if (this.queue.isEmpty) {
        this.setSpeaking(false)
      } else {
        this.playNext()
      }
    }

    this.currentCleanup = cleanupElement
    audio.addEventListener('playing', onPlaying)
    audio.addEventListener('ended', onEnded)
    audio.addEventListener('error', onError)

    console.log(`[voice] 开始播放 msg=${shortId(message_id)} seq=${seq}`)
    // 设备无音频 / 自动播放策略拒绝 → catch 后走 finish 继续队列（不崩不卡）
    audio.play().catch((err: unknown) => {
      console.warn('[voice] play() 被拒（设备无音频或策略限制）：', err)
      finish('play-rejected')
    })
  }

  /** 停止当前帧（打断/清残留）：置空引用 + 释放元素 + 闭嘴；幂等 */
  private stopCurrentAudio(): void {
    const audio = this.audio
    if (!audio) return
    this.audio = null
    this.playing = false
    this.currentMessageId = null
    const cleanup = this.currentCleanup
    this.currentCleanup = null
    cleanup?.()
    this.mouth.detach()
    // 注意：这里不推进队列——调用方（stopAll 清空了队列 / dropOtherMessages 自行 playNext）
  }

  private setSpeaking(speaking: boolean): void {
    if (this.speaking === speaking) return
    this.speaking = speaking
    console.log(`[voice] ${speaking ? '开始说话' : '回到待机（闭嘴）'}`)
    this.onSpeakingChange?.(speaking)
  }
}
