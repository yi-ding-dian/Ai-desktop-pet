/**
 * 任务对话记录（transcript）落盘（2026-10-25）。
 *
 * 与 store.ts 的分工：
 *  - store.ts 存「回看视图」（步骤、待办、总结），给人看；
 *  - 这里存「模型上下文」（user / assistant / toolResult / 中途 system），
 *    重启后据此重建 Agent，任务才能继续聊，而不只是回看。
 *
 * 每任务一个 JSON 文件，整文件原子写：保存时要按预算裁剪，无法纯追加。
 * 裁剪策略：图片换占位、思考内容丢弃、工具结果头尾截断；仍超预算时从最旧处
 * 丢到最近一条 user 消息，并在开头插一条 system 概要，避免恢复后「失忆」。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { AgentMessage } from '@earendil-works/pi-agent-core'

/** 文件格式版本（结构变化时递增，旧版本直接当损坏处理，不猜） */
export const TRANSCRIPT_VERSION = 1
/** 单个任务 transcript 的字符预算（约 6~8 万 token，给提示词和本轮输出留余量） */
export const MAX_TRANSCRIPT_CHARS = 120_000
/** 单任务保留的消息条数上限 */
export const MAX_TRANSCRIPT_MESSAGES = 400
/** 单条工具结果正文上限（头 4000 + 尾 1500，中间省略） */
export const MAX_TOOL_RESULT_CHARS = 5_500
const TOOL_RESULT_HEAD = 4_000
const TOOL_RESULT_TAIL = 1_500
/** 工具调用参数里单个字符串的上限（write_file 的正文可能很大） */
export const MAX_TOOL_ARG_CHARS = 2_000
/** 概要消息上限 */
const MAX_RECAP_CHARS = 2_000

export interface TranscriptSaveResult {
  /** 真正写了文件（没有可存的消息时为 false） */
  saved: boolean
  /** 因预算/条数上限被丢弃的消息条数 */
  dropped: number
}

/**
 * transcript 目录（由调用方传 userData 下的路径）。
 *
 * 这里不直接 import electron：离线单测在纯 Node 里跑，静态引入 electron 会捆进
 * CJS 入口导致 ESM 下 `require` 失败。
 */
export function transcriptDir(userData: string): string {
  return join(userData, 'agent-transcripts')
}

function transcriptFile(id: string, dir: string): string {
  return join(dir, `${id}.json`)
}

export function hasTranscript(id: string, dir: string): boolean {
  return Boolean(id) && existsSync(transcriptFile(id, dir))
}

export function deleteTranscript(id: string, dir: string): void {
  try {
    rmSync(transcriptFile(id, dir), { force: true })
  } catch (err) {
    console.warn('[agent] 删除对话记录失败：', (err as Error).message)
  }
}

/** 清理没有对应任务的旧 transcript（任务被裁掉/删除后遗留）。 */
export function pruneTranscripts(knownIds: readonly string[], dir: string): void {
  const known = new Set(knownIds)
  try {
    for (const name of readdirSync(dir)) {
      // 上次写一半留下的临时文件直接清掉
      if (name.endsWith('.tmp')) {
        rmSync(join(dir, name), { force: true })
        continue
      }
      if (!name.endsWith('.json')) continue
      if (known.has(basename(name, '.json'))) continue
      rmSync(join(dir, name), { force: true })
    }
  } catch (err) {
    // 目录还不存在属于正常情况
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn('[agent] 清理对话记录失败：', (err as Error).message)
    }
  }
}

/** 读任务记录；文件不存在返回 []，存在但损坏返回 null（调用方决定是否报错）。 */
export function loadTranscript(id: string, dir: string): AgentMessage[] | null {
  const file = transcriptFile(id, dir)
  if (!existsSync(file)) return []
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as {
      version?: unknown
      messages?: unknown
    }
    if (raw?.version !== TRANSCRIPT_VERSION || !Array.isArray(raw.messages)) return null
    const messages = raw.messages.filter(
      (item): item is AgentMessage =>
        Boolean(item && typeof item === 'object' && typeof (item as { role?: unknown }).role === 'string')
    )
    // 防御旧文件/手工改过的文件：开头的系统提示一律不认（恢复时按当天配置重建）；
    // 带 transcriptRecap 标记的概要保留（它就是文件的第一条 system）。
    let start = 0
    while (start < messages.length) {
      const item = messages[start] as LooseMessage
      if (item.role !== 'system' || item.transcriptRecap === true) break
      start += 1
    }
    return start > 0 ? messages.slice(start) : messages
  } catch (err) {
    console.warn('[agent] 对话记录读取失败：', (err as Error).message)
    return null
  }
}

/**
 * 保存任务记录（整文件原子写）。
 *
 * @param recap 有消息被预算裁掉时，写在最前面的概要（由调用方用任务/步骤生成）
 */
export function saveTranscript(
  id: string,
  messages: readonly AgentMessage[],
  recap: string,
  dir: string
): TranscriptSaveResult {
  const cleaned = sanitizeMessages(messages)
  const { kept, dropped } = trimMessages(cleaned, MAX_TRANSCRIPT_CHARS, MAX_TRANSCRIPT_MESSAGES)
  if (kept.length === 0) return { saved: false, dropped }

  const stored: AgentMessage[] =
    dropped > 0 && recap.trim()
      ? [
          {
            role: 'system',
            content: clip(recap, MAX_RECAP_CHARS),
            timestamp: Date.now(),
            // 标记：下次裁剪时旧概要直接丢弃，避免多次恢复后概要越滚越多
            transcriptRecap: true
          } as unknown as AgentMessage,
          ...kept
        ]
      : kept

  try {
    mkdirSync(dir, { recursive: true })
    const file = transcriptFile(id, dir)
    const tmp = `${file}.tmp`
    const body = JSON.stringify({ version: TRANSCRIPT_VERSION, savedAt: Date.now(), messages: stored })
    writeFileSync(tmp, body, 'utf8')
    renameSync(tmp, file)
    return { saved: true, dropped }
  } catch (err) {
    console.warn('[agent] 对话记录写入失败：', (err as Error).message)
    return { saved: false, dropped }
  }
}

// ------------------------------------------------------------------ 清理 / 裁剪

type Loose = Record<string, unknown>
type LooseMessage = Loose & { role?: unknown }

/**
 * 把运行中的消息变成可落盘、可恢复的形状（不修改原数组/对象）：
 *  - 丢掉开头的 system：恢复时按当天日期与当前模式重建；
 *  - 图片内容换成文字占位（base64 太大，文件还在，需要时让模型重新读）；
 *  - 思考内容不落盘（不发给模型，只占体积）；
 *  - 工具结果头尾截断；工具参数里的超长字符串截断；
 *  - 末尾「有 toolCall 没有结果」的半轮整段丢掉，避免恢复后请求被 API 拒绝。
 */
export function sanitizeMessages(messages: readonly AgentMessage[]): AgentMessage[] {
  const list = messages.filter(
    (item): item is AgentMessage =>
      Boolean(item && typeof item === 'object' && typeof (item as LooseMessage).role === 'string')
  )
  let start = 0
  while (start < list.length && (list[start] as LooseMessage).role === 'system') start += 1

  const out: AgentMessage[] = []
  for (const raw of list.slice(start)) {
    const role = (raw as LooseMessage).role
    if (role === 'system') {
      if ((raw as Loose).transcriptRecap === true) continue
      out.push({ ...(raw as Loose) } as AgentMessage)
      continue
    }
    if (role === 'user') {
      out.push(cloneWithContent(raw as Loose, 'user'))
      continue
    }
    if (role === 'assistant') {
      out.push(cloneWithContent(raw as Loose, 'assistant'))
      continue
    }
    if (role === 'toolResult') {
      // details / nestedCalls 只给界面看，不发给模型，不落盘
      const rest: Loose = { ...(raw as Loose) }
      delete rest.details
      delete rest.nestedCalls
      out.push(cloneWithContent(rest, 'tool'))
      continue
    }
    // 未知 role：不猜，直接丢弃
  }
  return dropDanglingTail(out)
}

function cloneWithContent(raw: LooseMessage, kind: 'user' | 'assistant' | 'tool'): AgentMessage {
  return {
    ...raw,
    content: sanitizeContent((raw as Loose).content, kind)
  } as AgentMessage
}

function sanitizeContent(content: unknown, kind: 'user' | 'assistant' | 'tool'): unknown {
  if (typeof content === 'string') {
    return kind === 'tool' ? clipMiddle(content, MAX_TOOL_RESULT_CHARS) : content
  }
  if (!Array.isArray(content)) return content
  const out: unknown[] = []
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    const item = block as Loose
    if (item.type === 'image') {
      out.push({
        type: 'text',
        text:
          kind === 'tool'
            ? '[图片结果已省略：需要时请重新执行工具]'
            : '[图片已省略：重启后不再重传，需要时请让用户重新发送]'
      })
      continue
    }
    if (item.type === 'thinking') continue
    if (item.type === 'text' && typeof item.text === 'string') {
      out.push({
        ...item,
        text: kind === 'tool' ? clipMiddle(item.text, MAX_TOOL_RESULT_CHARS) : item.text
      })
      continue
    }
    if (item.type === 'toolCall') {
      out.push({ ...item, arguments: trimJson(item.arguments, MAX_TOOL_ARG_CHARS) })
      continue
    }
    out.push({ ...item })
  }
  return out
}

function trimJson(value: unknown, budget: number): unknown {
  if (typeof value === 'string') {
    return value.length > budget ? `${value.slice(0, budget)}…[已截断]` : value
  }
  if (Array.isArray(value)) return value.map((item) => trimJson(item, budget))
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) out[key] = trimJson(item, budget)
    return out
  }
  return value
}

/** 末尾半轮工具调用（应用被关掉/中止时）整段丢弃。 */
export function dropDanglingTail(messages: AgentMessage[]): AgentMessage[] {
  const out = messages.slice()
  for (;;) {
    let lastAssistant = -1
    for (let i = out.length - 1; i >= 0; i -= 1) {
      if ((out[i] as LooseMessage).role === 'assistant') {
        lastAssistant = i
        break
      }
    }
    if (lastAssistant < 0) break
    const calls = toolCallIds(out[lastAssistant])
    if (calls.length === 0) break
    const answered = new Set<string>()
    for (let i = lastAssistant + 1; i < out.length; i += 1) {
      const item = out[i] as LooseMessage
      if (item.role === 'toolResult' && typeof item.toolCallId === 'string') {
        answered.add(item.toolCallId)
      }
    }
    if (calls.every((id) => answered.has(id))) break
    out.splice(lastAssistant)
  }
  return out
}

function toolCallIds(message: AgentMessage): string[] {
  const content = (message as LooseMessage).content
  if (!Array.isArray(content)) return []
  return content
    .filter((block): block is Loose => Boolean(block && typeof block === 'object'))
    .filter((block) => block.type === 'toolCall' && typeof block.id === 'string')
    .map((block) => block.id as string)
}

/** 从末尾保留消息直到超出预算，然后把开头对齐到最近一条 user/system 消息。 */
export function trimMessages(
  messages: readonly AgentMessage[],
  maxChars: number,
  maxCount: number
): { kept: AgentMessage[]; dropped: number } {
  if (messages.length === 0) return { kept: [], dropped: 0 }
  let start = messages.length
  let used = 0
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const size = estimateChars(messages[i])
    const first = start === messages.length
    if (!first && (used + size > maxChars || messages.length - i > maxCount)) break
    used += size
    start = i
  }
  // 不能从工具结果/助手消息中间开始：对齐到最近一条 user（或概要 system）
  let aligned = start
  while (aligned < messages.length) {
    const role = (messages[aligned] as LooseMessage).role
    if (role === 'user' || role === 'system') break
    aligned += 1
  }
  if (aligned >= messages.length) {
    // 末尾这段本身没有 user（例如只剩最后一条助手回复）：向前找最近的 user，
    // 宁可略微超预算，也要保住最后一条用户消息及其回复
    let fallback = -1
    for (let i = start - 1; i >= 0; i -= 1) {
      const role = (messages[i] as LooseMessage).role
      if (role === 'user' || role === 'system') {
        fallback = i
        break
      }
    }
    if (fallback < 0) {
      // 整段都没有 user/system：放弃，避免留下孤立的工具结果
      return { kept: [], dropped: messages.length }
    }
    aligned = fallback
  }
  return { kept: messages.slice(aligned), dropped: aligned }
}

function estimateChars(message: AgentMessage): number {
  try {
    return JSON.stringify(message).length
  } catch {
    return 0
  }
}

// ------------------------------------------------------------------ 小工具

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`
}

function clipMiddle(text: string, max: number): string {
  if (text.length <= max) return text
  const tail = Math.min(TOOL_RESULT_TAIL, Math.max(0, max - TOOL_RESULT_HEAD))
  return `${text.slice(0, TOOL_RESULT_HEAD)}\n…[中间省略 ${text.length - TOOL_RESULT_HEAD - tail} 字]…\n${text.slice(-tail)}`
}
