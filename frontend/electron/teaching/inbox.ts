/** 黑板收件箱缓存：渲染就绪前的 mirror/goto/visibility 指令按序暂存。 */
import type { TeachingBoardInbox } from '../ipc/channels'

/** 收件箱缓存上限（条）：超出丢弃最旧 */
const DEFAULT_LIMIT = 200

export class BoardInbox {
  private ready = false
  private pending: TeachingBoardInbox[] = []

  constructor(private readonly limit = DEFAULT_LIMIT) {}

  isReady(): boolean {
    return this.ready
  }

  markReady(): void {
    this.ready = true
  }

  /** 黑板意外关闭：只复位就绪标志，保留缓存在重建后回放 */
  markUnready(): void {
    this.ready = false
  }

  reset(): void {
    this.ready = false
    this.pending = []
  }

  /** 黑板未就绪时入缓存（上限内丢最旧） */
  enqueue(item: TeachingBoardInbox): void {
    this.pending.push(item)
    if (this.pending.length > this.limit) {
      this.pending.splice(0, this.pending.length - this.limit)
    }
  }

  /** 取出全部缓存（就绪后按序回放） */
  take(): TeachingBoardInbox[] {
    const items = this.pending
    this.pending = []
    return items
  }

  /** 窗口重建前留一份尾部缓存（重建后尽力回放） */
  tail(): TeachingBoardInbox[] {
    return this.pending.slice(-this.limit)
  }

  restore(items: TeachingBoardInbox[]): void {
    this.pending = items
  }
}
