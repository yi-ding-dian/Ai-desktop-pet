/**
 * voice 域 DEV 调试工具：合成"说话感"测试音（WAV），用于走真实播放链路自测
 * （Blob → ObjectURL → HTMLAudioElement → Web Audio 口型 → 结束清理）。
 *
 * 纯函数（无 DOM 依赖，可单测）；WAV 格式（16-bit PCM 单声道）被 Chromium 直接识别，
 * 免去内嵌二进制素材——调试帧 header.format 记为 'wav' 以区别于正式 mp3。
 */
import type { AudioFramePacket } from '../../shared/protocol'

/** 写 ASCII 标记（WAV 头用） */
function writeAscii(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i))
}

/** 写 44 字节 WAV 头（RIFF / fmt / data） */
function writeWavHeader(view: DataView, dataBytes: number, sampleRate: number): void {
  writeAscii(view, 0, 'RIFF')
  view.setUint32(4, 36 + dataBytes, true) // 文件总长 - 8
  writeAscii(view, 8, 'WAVE')
  writeAscii(view, 12, 'fmt ')
  view.setUint32(16, 16, true) // fmt 块长
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, 1, true) // 单声道
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true) // byte rate（单声道 16bit → ×2）
  view.setUint16(32, 2, true) // block align
  view.setUint16(34, 16, true) // 位深
  writeAscii(view, 36, 'data')
  view.setUint32(40, dataBytes, true)
}

/**
 * 合成一段"说话感"测试音：4 个音节循环（每 0.4s：0.3s 出声 + 0.1s 停顿），
 * 基频 220/260/300/240Hz 起伏，音节内平滑起落包络 → 口型有张有合有停顿。
 * @returns WAV 字节（ArrayBuffer）
 */
export function buildTestToneWav(sampleRate = 24000, seconds = 1.6): ArrayBuffer {
  const sampleCount = Math.floor(sampleRate * seconds)
  const buf = new ArrayBuffer(44 + sampleCount * 2)
  const view = new DataView(buf)
  writeWavHeader(view, sampleCount * 2, sampleRate)

  const SYLLABLE = 0.4 // 音节周期（秒）
  const VOICED = 0.75 // 音节内出声占比
  const F0 = [220, 260, 300, 240] // 各音节基频（Hz）
  for (let i = 0; i < sampleCount; i++) {
    const t = i / sampleRate
    const phase = (t % SYLLABLE) / SYLLABLE
    // 音节内包络：sin 平滑起落；超过出声占比则静音（停顿）
    const env = phase < VOICED ? Math.sin(Math.PI * (phase / VOICED)) : 0
    const f0 = F0[Math.floor(t / SYLLABLE) % F0.length]
    const sample = 0.45 * env * Math.sin(2 * Math.PI * f0 * t)
    view.setInt16(44 + i * 2, Math.round(Math.max(-1, Math.min(1, sample)) * 0x7fff), true)
  }
  return buf
}

/** 构造一帧调试音频（§3.5 假帧；format='wav'，仅 dev 调试入口使用） */
export function makeDebugVoiceFrame(seconds = 1.6): AudioFramePacket {
  return {
    header: {
      type: 'audio',
      message_id: `debug-${Date.now().toString(36)}`,
      seq: 0,
      format: 'wav',
      sample_rate: 24000,
      final: true
    },
    payload: buildTestToneWav(24000, seconds)
  }
}
