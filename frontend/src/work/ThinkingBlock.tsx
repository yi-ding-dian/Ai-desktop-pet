/**
 * 「已思考」折叠块（工作模式，2026-10-18）。
 *
 * - 推理流进行中：自动展开，显示「思考中…（已 Ns）」；
 * - 结束后：收起为「已思考（用时 N 秒）」，点击可重新展开；
 * - 没有 reasoning 增量（非推理模型 / 网关不返回 reasoning_content）时整块不渲染。
 */
import { useEffect, useState, type ReactElement } from 'react'

export interface ThinkingBlockProps {
  reasoning: string
  streaming: boolean
  /** 本轮用户消息发送时间（流式中用于秒表） */
  startedAt: number
  /** 首个正文 token 到达时定稿的用时（ms） */
  thinkingMs?: number
}

function secondsOf(ms: number): number {
  return Math.max(1, Math.round(ms / 1000))
}

export default function ThinkingBlock({
  reasoning,
  streaming,
  startedAt,
  thinkingMs
}: ThinkingBlockProps): ReactElement | null {
  const [open, setOpen] = useState(true)
  /** 流式秒表（每 500ms 刷新一次） */
  const [nowTick, setNowTick] = useState(() => Date.now())

  useEffect(() => {
    if (!streaming) return
    const timer = window.setInterval(() => setNowTick(Date.now()), 500)
    return () => window.clearInterval(timer)
  }, [streaming])

  // 思考结束自动收起（用户也可随时手动展开）
  useEffect(() => {
    if (!streaming) setOpen(false)
  }, [streaming])

  if (reasoning.length === 0) return null

  const elapsed = thinkingMs ?? Math.max(0, nowTick - startedAt)
  const seconds = secondsOf(elapsed)

  return (
    <div className={`work-thinking${open ? ' work-thinking-open' : ''}`}>
      <button
        type="button"
        className="work-thinking-toggle"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="work-thinking-icon" aria-hidden="true">
          ◌
        </span>
        {streaming ? (
          <span>思考中…（已 {seconds} 秒）</span>
        ) : (
          <span>已思考（用时 {seconds} 秒）</span>
        )}
        <span className="work-thinking-caret" aria-hidden="true">
          {open ? '▾' : '▸'}
        </span>
      </button>
      {open ? <div className="work-thinking-text">{reasoning}</div> : null}
    </div>
  )
}
