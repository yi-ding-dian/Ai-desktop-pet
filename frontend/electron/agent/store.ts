/**
 * 任务会话记录落盘（2026-10-23）。
 *
 * 只存「可回看」的部分：任务名、工作区、步骤、待办、总结、错误、状态。
 * Agent 与确认卡不落盘——重启后上下文不可恢复（见设计文档 §3）。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { app } from 'electron'
import type { AgentSourceItem, AgentStatus, AgentStep, AgentTodoItem, AgentUsage } from './types'

/** 单文件保留的任务条数上限（超出的按 updatedAt 丢弃最旧） */
const MAX_SESSIONS = 30
/** 每条任务落盘的步骤上限与单条正文上限（控制文件体积） */
const MAX_PERSISTED_STEPS = 120
const MAX_PERSISTED_DETAIL = 1500
/** 每条任务落盘的来源条数上限（摘要已截断到 300 字，够悬浮卡片用） */
const MAX_PERSISTED_SOURCES = 40

export interface PersistedSession {
  id: string
  task: string
  workspace: string
  createdAt: number
  updatedAt: number
  status: AgentStatus
  steps: AgentStep[]
  todos: AgentTodoItem[]
  /** 任务累计用量（旧记录可能没有） */
  usage?: AgentUsage
  /** 联网来源（旧记录可能没有；回看时悬浮卡片用） */
  sources?: AgentSourceItem[]
  summary?: string
  error?: string
}

export interface PersistedState {
  activeId: string | null
  sessions: PersistedSession[]
}

function storePath(): string {
  return join(app.getPath('userData'), 'agent-sessions.json')
}

/** 读盘：损坏 / 缺失一律回退空列表（不影响启动） */
export function loadSessions(): PersistedState {
  const file = storePath()
  if (!existsSync(file)) return { activeId: null, sessions: [] }
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<PersistedState>
    const sessions = Array.isArray(raw.sessions)
      ? raw.sessions.filter((item): item is PersistedSession => Boolean(item && item.id && item.task))
      : []
    sessions.sort((a, b) => b.updatedAt - a.updatedAt)
    return {
      activeId: typeof raw.activeId === 'string' ? raw.activeId : null,
      sessions: sessions.slice(0, MAX_SESSIONS)
    }
  } catch (err) {
    console.warn('[agent] 会话记录损坏，已忽略：', (err as Error).message)
    return { activeId: null, sessions: [] }
  }
}

/** 原子写：临时文件 + rename，避免写一半损坏 */
export function saveSessions(state: PersistedState): void {
  const file = storePath()
  try {
    mkdirSync(dirname(file), { recursive: true })
    const sessions = state.sessions
      .slice()
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, MAX_SESSIONS)
      .map((session) => ({
        ...session,
        steps: session.steps.slice(-MAX_PERSISTED_STEPS).map((step) => ({
          ...step,
          detail: step.detail ? step.detail.slice(0, MAX_PERSISTED_DETAIL) : step.detail
        })),
        sources: session.sources?.slice(0, MAX_PERSISTED_SOURCES)
      }))
    const body = JSON.stringify({ activeId: state.activeId, sessions })
    const tmp = `${file}.tmp`
    writeFileSync(tmp, body, 'utf8')
    renameSync(tmp, file)
  } catch (err) {
    console.warn('[agent] 会话记录写入失败：', (err as Error).message)
  }
}
