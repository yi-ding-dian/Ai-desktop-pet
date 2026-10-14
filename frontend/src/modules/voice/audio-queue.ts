/**
 * 音频帧播放队列（设计文档 §4.4 前端侧）：收到帧 → 入队 → 顺序播放。
 *
 * 纯数据结构，无 DOM/音频依赖（可单测）：
 * - 按 message_id 分组（后台一句话一帧；组 = 该消息的所有待播帧）；
 * - 组内按 seq 升序（插入排序，同 seq 保持到达顺序）；
 * - 组间按到达顺序（FIFO）：上一轮播完自然轮到下一轮；
 * - 同一时刻只提供一帧（dequeue 一帧、播一帧）；
 * - 打断：clear() 全部丢弃；防御性清残留：clearExcept(messageId)。
 */
import type { AudioFramePacket } from '../../shared/protocol'

/** 一个消息的待播帧组 */
interface QueueGroup {
  messageId: string
  /** 该消息的待播帧（按 seq 升序） */
  frames: AudioFramePacket[]
}

export class AudioQueue {
  private groups: QueueGroup[] = []
  /** 总帧数（快照计数，避免每次求 size 遍历） */
  private count = 0

  /** 队列内待播帧总数 */
  get size(): number {
    return this.count
  }

  get isEmpty(): boolean {
    return this.count === 0
  }

  /** 最早组（下一帧所属消息）的 message_id；空队列返回 null */
  get currentMessageId(): string | null {
    return this.groups[0]?.messageId ?? null
  }

  /** 入队一帧：按 message_id 归组，组内按 seq 升序插入 */
  enqueue(packet: AudioFramePacket): void {
    const { message_id, seq } = packet.header
    let group = this.groups.find((g) => g.messageId === message_id)
    if (!group) {
      group = { messageId: message_id, frames: [] }
      this.groups.push(group)
    }
    // 插入排序：从尾部找第一个 seq <= 新帧的位置（严格大于才后移 → 同 seq 保持到达顺序）
    let i = group.frames.length
    while (i > 0 && group.frames[i - 1].header.seq > seq) i--
    group.frames.splice(i, 0, packet)
    this.count++
  }

  /** 取出最早组的最早一帧；空队列返回 null */
  dequeue(): AudioFramePacket | null {
    const group = this.groups[0]
    if (!group) return null
    const frame = group.frames.shift()!
    this.count--
    if (group.frames.length === 0) this.groups.shift()
    return frame
  }

  /** 清空全部待播帧（打断 / 强制停止） */
  clear(): void {
    this.groups = []
    this.count = 0
  }

  /**
   * 只保留指定 message_id 的帧（收到新 reply_start 时清上一轮残留，防御迟到帧）。
   * @returns 被丢弃的帧数（0 = 无残留）
   */
  clearExcept(messageId: string): number {
    const before = this.count
    this.groups = this.groups.filter((g) => g.messageId === messageId)
    this.count = this.groups.reduce((n, g) => n + g.frames.length, 0)
    return before - this.count
  }
}
