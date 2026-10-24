/**
 * 任务并发队列的纯逻辑（2026-10-24）。
 *
 * 规则：
 *  - 最多 MAX_PARALLEL_TASKS 个任务同时执行；
 *  - 同一工作区互斥（两个任务同时改同一目录会互相踩）；
 *  - 队首的工作区被占用时跳过它，先跑后面可运行的，避免空闲槽位干等。
 */
import type { ImageContent } from '@earendil-works/pi-ai'
import type { AgentAttachment } from './types'

export const MAX_PARALLEL_TASKS = 2

export interface QueueItem {
  sessionId: string
  /** 工作区 realpath（互斥键） */
  workspace: string
  kind: 'start' | 'continue'
  enqueuedAt: number
  /** kind='continue' 时的用户消息 */
  text?: string
  images?: ImageContent[]
  /** kind='start' 时的初始附件 */
  attachments?: AgentAttachment[]
}

/** 找出第一个工作区未被占用的队列项；没有则返回 -1。 */
export function findRunnableIndex(
  queue: readonly QueueItem[],
  runningWorkspaces: ReadonlySet<string>
): number {
  return queue.findIndex((item) => !runningWorkspaces.has(item.workspace))
}
