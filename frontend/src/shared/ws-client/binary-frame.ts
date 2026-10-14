/**
 * 二进制帧解析（设计文档 §3.5）：
 *   [4字节 大端 JSON头长度 N][JSON头 N字节][音频数据]
 *
 * 与后端 `interfaces/ws/protocol.py` 的 pack_audio_frame 对偶（4 字节大端头长 + UTF-8 JSON 头；
 * 2026-10-14 与后端实现逐字段核对通过）。
 * 约定：**解析失败绝不抛异常**，返回 null 并记警告日志（坏帧不得影响 WS 连接与播放队列）。
 */
import type { AudioFrameHeader, AudioFramePacket } from '../protocol'

/** JSON 头解码器（TextDecoder 无状态，模块级复用） */
const headerDecoder = new TextDecoder()

/**
 * 解析一个完整二进制音频帧。
 * @returns 解析成功返回 {header, payload}；任何格式问题返回 null（已记日志）
 */
export function parseAudioFrame(buf: ArrayBuffer): AudioFramePacket | null {
  if (buf.byteLength < 4) {
    console.warn(`[ws] 二进制帧过短（${buf.byteLength} 字节，不足 4 字节头长度），已丢弃`)
    return null
  }

  // 头长度：大端 uint32（DataView 第二参 false = 大端）
  const headerLen = new DataView(buf).getUint32(0, false)
  if (headerLen === 0 || 4 + headerLen > buf.byteLength) {
    console.warn(
      `[ws] 二进制帧头长度非法（N=${headerLen}，帧长=${buf.byteLength}），已丢弃`
    )
    return null
  }

  let header: AudioFrameHeader
  try {
    const raw = headerDecoder.decode(new Uint8Array(buf, 4, headerLen))
    header = JSON.parse(raw) as AudioFrameHeader
  } catch {
    console.warn('[ws] 二进制帧 JSON 头解析失败，已丢弃')
    return null
  }

  if (header?.type !== 'audio' || typeof header.message_id !== 'string') {
    console.warn(`[ws] 二进制帧头字段非法（type=${String(header?.type)}），已丢弃`)
    return null
  }

  // 音频体：直接 slice 出独立 ArrayBuffer（单次复制；Blob 构造本来也会复制一份，合并不划算）
  return { header, payload: buf.slice(4 + headerLen) }
}
