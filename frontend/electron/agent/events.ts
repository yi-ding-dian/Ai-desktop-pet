/** Agent 事件流 → 面板步骤（思考/回复/工具/待办/统计）。 */
import type { Agent, AgentEvent } from '@earendil-works/pi-agent-core'
import { describeToolCall } from './tools'
import {
  MAX_STEPS,
  MAX_STEP_DETAIL,
  clipText,
  type Session
} from './session'
import type { AgentStep, AgentTodoItem } from './types'

export interface EventHandlers {
  touch: (session: Session) => void
  audit: (event: string, data: Record<string, unknown>) => void
}

export class AgentEventTranslator {
  constructor(private readonly handlers: EventHandlers) {}

  onAgentEvent(session: Session, event: AgentEvent): void {
    if (session.state.status === 'cancelled') return
    switch (event.type) {
      case 'turn_start': {
        // 每次请求模型立刻给一个可见占位：等待首字时不至于像卡死
        session.turn += 1
        session.state.usage.calls += 1
        session.roundCalls += 1
        if (!session.roundStartedAt) session.roundStartedAt = Date.now()
        this.pushStep(session, {
          id: `thinking-${session.turn}`,
          kind: 'thinking',
          turn: session.turn,
          title: '思考过程',
          detail: '',
          status: 'running',
          startedAt: Date.now()
        })
        break
      }
      case 'message_update': {
        const inner = event.assistantMessageEvent
        if (inner.type === 'text_delta') {
          this.closeThinking(session, session.turn)
          this.appendStream(session, 'text', inner.delta, session.turn)
        } else if (inner.type === 'thinking_delta') {
          this.appendStream(session, 'thinking', inner.delta, session.turn)
        } else if (inner.type === 'text_end') {
          this.closeStream(session, 'text', session.turn)
        } else if (inner.type === 'thinking_end') {
          this.closeThinking(session, session.turn)
        }
        break
      }
      case 'message_end': {
        // 模型响应结束：累计 usage，并挂到本轮正文（没有正文就挂到本轮工具行）
        const message = event.message as {
          role?: string
          usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number }
        }
        if (message?.role !== 'assistant' || !message.usage) break
        const input = message.usage.input ?? 0
        const output = message.usage.output ?? 0
        const cacheRead = message.usage.cacheRead ?? 0
        session.state.usage.input += input
        session.state.usage.output += output
        session.state.usage.cacheRead += cacheRead
        session.roundInput += input
        session.roundOutput += output
        session.roundCache += cacheRead
        // 当前上下文 = 本次请求的输入（含缓存部分）+ 本次输出
        const windowSize = session.state.context?.window ?? 0
        const cacheWrite = message.usage.cacheWrite ?? 0
        session.state.context = {
          used: input + cacheRead + cacheWrite + output,
          window: windowSize
        }
        const turn = session.turn
        const textStep = session.state.steps.find((step) => step.id === `text-${turn}`)
        if (textStep) {
          textStep.tokens = { input, output }
        } else {
          // 这一轮只有工具调用、没有正文：留给该轮的工具行
          session.turnTokens.set(turn, { input, output })
          const toolStep = session.state.steps.find(
            (step) => step.kind === 'tool' && step.turn === turn
          )
          if (toolStep) {
            toolStep.tokens = { input, output }
            session.turnTokens.delete(turn)
          }
        }
        this.handlers.touch(session)
        break
      }
      case 'turn_end': {
        this.closeStream(session, 'text', session.turn)
        this.closeThinking(session, session.turn)
        break
      }
      case 'tool_execution_start': {
        const desc = describeToolCall(event.toolName, event.args, session.state.workspace)
        this.handlers.audit('tool', {
          id: session.state.id,
          name: event.toolName,
          args: JSON.stringify(event.args ?? {}).slice(0, 300)
        })
        const step: AgentStep = {
          id: event.toolCallId,
          kind: 'tool',
          turn: session.turn,
          title: desc.title,
          detail: desc.command ?? desc.preview,
          command: desc.command,
          status: 'running',
          startedAt: Date.now()
        }
        const tokens = session.turnTokens.get(session.turn)
        const hasToolToken = session.state.steps.some(
          (item) => item.kind === 'tool' && item.turn === session.turn && item.tokens
        )
        if (tokens && !hasToolToken) {
          step.tokens = tokens
          session.turnTokens.delete(session.turn)
        }
        this.pushStep(session, step)
        break
      }
      case 'tool_execution_update': {
        // 长命令的进度（如「已运行 42 秒…」）实时落到步骤详情，避免看起来卡死
        const step = session.state.steps.find((item) => item.id === event.toolCallId)
        if (!step) break
        const content = (event.partialResult as { content?: unknown } | undefined)?.content
        const text = Array.isArray(content)
          ? content
              .filter((block): block is { type: string; text: string } =>
                Boolean(block) && (block as { type?: string }).type === 'text'
              )
              .map((block) => block.text)
              .join(' ')
          : ''
        if (text) {
          step.detail = clipText(text, 200)
          this.handlers.touch(session)
        }
        break
      }
      case 'tool_execution_end': {
        const step = session.state.steps.find((item) => item.id === event.toolCallId)
        if (step) {
          step.status = event.isError ? 'failed' : 'done'
          step.endedAt = Date.now()
          const text = this.extractToolText(event)
          if (text) step.detail = clipText(text, 400)
          this.handlers.touch(session)
        }
        break
      }
      case 'agent_end': {
        this.closeStream(session, 'text', session.turn)
        this.closeThinking(session, session.turn)
        break
      }
      default:
        break
    }
  }

  private extractToolText(event: Extract<AgentEvent, { type: 'tool_execution_end' }>): string {
    const content = event.result?.content
    if (!Array.isArray(content)) return ''
    return content
      .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
      .map((block) => block.text)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim()
  }

  private appendStream(
    session: Session,
    kind: 'text' | 'thinking',
    delta: string,
    turn: number
  ): void {
    const id = `${kind}-${turn}`
    let step = session.state.steps.find((item) => item.id === id)
    if (!step) {
      step = {
        id,
        kind,
        turn,
        title: kind === 'text' ? '回复' : '思考过程',
        detail: '',
        status: 'running',
        startedAt: Date.now()
      }
      session.state.steps.push(step)
      this.trimSteps(session)
    }
    step.detail = clipText((step.detail ?? '') + delta, MAX_STEP_DETAIL)
    this.handlers.touch(session)
  }

  private closeStream(session: Session, kind: 'text' | 'thinking', turn: number): void {
    const step = session.state.steps.find((item) => item.id === `${kind}-${turn}`)
    if (!step || step.status !== 'running') return
    step.status = 'done'
    step.endedAt = Date.now()
    if (kind === 'text' && (step.detail ?? '').trim() === '') {
      session.state.steps = session.state.steps.filter((item) => item !== step)
    }
    this.handlers.touch(session)
  }

  /** 思考占位：收到正文或本轮结束就收口；没有思考内容则移除（运行中保留，用来显示「正在思考…」） */
  private closeThinking(session: Session, turn: number): void {
    const step = session.state.steps.find((item) => item.id === `thinking-${turn}`)
    if (!step || step.status !== 'running') return
    step.status = 'done'
    step.endedAt = Date.now()
    if ((step.detail ?? '').trim() === '') {
      session.state.steps = session.state.steps.filter((item) => item !== step)
    }
    this.handlers.touch(session)
  }

  pushStep(session: Session, step: AgentStep): void {
    session.state.steps.push(step)
    this.trimSteps(session)
    this.handlers.touch(session)
  }

  /** 步骤上限：只丢已结束的最旧步骤，正在跑的保留 */
  private trimSteps(session: Session): void {
    if (session.state.steps.length <= MAX_STEPS) return
    const overflow = session.state.steps.length - MAX_STEPS
    let removed = 0
    session.state.steps = session.state.steps.filter((step) => {
      if (removed >= overflow) return true
      if (step.status === 'running') return true
      removed += 1
      return false
    })
  }

  applyTodo(
    session: Session,
    items: Array<{ text: string; status: 'pending' | 'active' | 'done' }>
  ): void {
    const todos: AgentTodoItem[] = items.map((item, index) => ({
      id: `todo-${index}`,
      text: item.text,
      status: item.status
    }))
    session.state.todos = todos
    const step = session.state.steps.find((item) => item.id === 'todo')
    const line = todos
      .map(
        (item) =>
          `${item.status === 'done' ? '☑' : item.status === 'active' ? '▸' : '☐'} ${item.text}`
      )
      .join('\n')
    if (step) {
      step.detail = line
      step.status = 'done'
    } else {
      session.state.steps.push({
        id: 'todo',
        kind: 'todo',
        title: '拆解任务',
        detail: line,
        status: 'done',
        startedAt: Date.now(),
        endedAt: Date.now()
      })
    }
    this.handlers.touch(session)
  }

  extractSummary(agent: Agent): string {
    const messages = agent.state?.messages ?? []
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const message = messages[i]
      if (message.role !== 'assistant') continue
      const text = (message.content ?? [])
        .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
        .map((block) => block.text)
        .join('\n')
        .trim()
      if (text) return clipText(text, MAX_STEP_DETAIL)
    }
    return ''
  }
}
