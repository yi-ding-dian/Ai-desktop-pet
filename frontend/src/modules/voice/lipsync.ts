/**
 * 口型驱动（设计文档 §4.4/§5.3）：Web Audio `AnalyserNode` 取实时音量包络 → 0–1 → `PetRenderer.setMouth`。
 *
 * 音频链：MediaElementAudioSourceNode → AnalyserNode → destination（扬声器）。
 * 注意：`createMediaElementSource` 对同一个 HTMLMediaElement 只能调用一次（再次调用抛错），
 * 因此每个播放元素 attach 一次；AudioContext 则跨帧复用（浏览器限制同页 AudioContext 数量）。
 *
 * 口型策略：上升快（跟开口）、下降慢（防抖动），时间常数按帧率无关的指数平滑计算。
 */
import { clamp01 } from './audio-util'

/** 口型驱动参数 */
export interface LipsyncConfig {
  /** RMS→level 线性增益（语音 RMS 常 <0.35，需放大才能张满嘴） */
  gain: number
  /** 张口平滑时间常数（秒）：小 = 跟得快 */
  attackTau: number
  /** 闭嘴平滑时间常数（秒）：大 = 收得慢、不抖 */
  releaseTau: number
}

export const DEFAULT_LIPSYNC_CONFIG: LipsyncConfig = {
  gain: 4.5,
  attackTau: 0.035,
  releaseTau: 0.14
}

/** RMS 音量 → 口型开合 0–1（纯函数，供单测） */
export function rmsToLevel(rms: number, gain: number): number {
  return clamp01(rms * gain)
}

/** 指数平滑一帧（帧率无关：k = 1 - e^(-dt/τ)；纯函数，供单测） */
export function smoothLevel(
  current: number,
  target: number,
  dt: number,
  cfg: LipsyncConfig
): number {
  const tau = target > current ? cfg.attackTau : cfg.releaseTau
  return current + (target - current) * (1 - Math.exp(-dt / tau))
}

/** 口型驱动：把一个播放中的媒体元素接入分析链，逐帧输出 0–1 包络 */
export class MouthDriver {
  private ctx: AudioContext | null = null
  private analyser: AnalyserNode | null = null
  private source: MediaElementAudioSourceNode | null = null
  /** 时域采样缓冲（长度 = fftSize；TS 5.7 起 Float32Array 带缓冲类型参数） */
  private buf: Float32Array<ArrayBuffer> | null = null
  private rafId: number | null = null
  private lastTs: number | null = null
  private level = 0
  /** dev 包络日志节流时间戳 */
  private lastLogTs = 0

  constructor(
    private readonly onLevel: (level: number) => void,
    private readonly cfg: LipsyncConfig = DEFAULT_LIPSYNC_CONFIG
  ) {}

  /**
   * 接入媒体元素并开始驱动口型（重复调用先断开旧的）。
   * @returns 接入成功 true；Web Audio 不可用等异常返回 false（调用方继续纯播放，不影响队列）
   */
  attach(el: HTMLMediaElement): boolean {
    this.detach()
    try {
      const ctx = this.ensureContext()
      const source = ctx.createMediaElementSource(el)
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 1024 // 时间域缓冲长度 = fftSize（约 43ms @24kHz，够做包络）
      source.connect(analyser)
      analyser.connect(ctx.destination) // 经 AudioContext 输出（createMediaElementSource 后元素原生输出被接管）
      this.source = source
      this.analyser = analyser
      this.buf = new Float32Array(analyser.fftSize)
      this.level = 0
      this.lastTs = null
      this.rafId = requestAnimationFrame(this.tick)
      return true
    } catch (err) {
      console.warn('[voice] 口型驱动接入失败（继续播放，无口型）：', err)
      this.detach()
      return false
    }
  }

  /** 断开分析链并闭嘴（播放结束/出错/打断时调用；可重复调用） */
  detach(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId)
      this.rafId = null
    }
    try {
      this.source?.disconnect()
      this.analyser?.disconnect()
    } catch {
      /* 已断开 */
    }
    this.source = null
    this.analyser = null
    this.buf = null
    this.level = 0
    this.onLevel(0) // 停止播放即闭嘴（任务约定）
  }

  /** 释放（页面卸载级；当前生命周期用不到，留作完整释放） */
  dispose(): void {
    this.detach()
    if (this.ctx) {
      void this.ctx.close().catch(() => undefined)
      this.ctx = null
    }
  }

  // ---------------- 内部 ----------------

  /** 懒创建并复用 AudioContext；suspended 时尝试恢复（Electron 默认无手势限制，仍防御） */
  private ensureContext(): AudioContext {
    if (!this.ctx) {
      const Ctor =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      if (!Ctor) throw new Error('Web Audio 不可用（无 AudioContext）')
      this.ctx = new Ctor()
    }
    if (this.ctx.state === 'suspended') {
      void this.ctx.resume().catch((err: unknown) => {
        console.warn('[voice] AudioContext.resume 失败（可能导致无声音）：', err)
      })
    }
    return this.ctx
  }

  /** 每帧：取时域波形 → RMS → 平滑 → 输出口型 */
  private readonly tick = (ts: number): void => {
    this.rafId = requestAnimationFrame(this.tick)
    if (!this.analyser || !this.buf) return
    if (this.lastTs === null) {
      this.lastTs = ts
      return
    }
    const dt = Math.min(0.1, (ts - this.lastTs) / 1000) // 防切后台跳变
    this.lastTs = ts

    this.analyser.getFloatTimeDomainData(this.buf)
    let sum = 0
    for (let i = 0; i < this.buf.length; i++) sum += this.buf[i] * this.buf[i]
    const rms = Math.sqrt(sum / this.buf.length)
    const target = rmsToLevel(rms, this.cfg.gain)
    this.level = clamp01(smoothLevel(this.level, target, dt, this.cfg))
    this.onLevel(this.level)

    // dev 态包络日志（节流 600ms，作为"播放期间 setMouth 被驱动"的验证证据）
    if (import.meta.env.DEV) {
      const now = Date.now()
      if (now - this.lastLogTs > 600) {
        this.lastLogTs = now
        console.log(`[voice] lipsync level=${this.level.toFixed(2)} (rms=${rms.toFixed(3)})`)
      }
    }
  }
}
