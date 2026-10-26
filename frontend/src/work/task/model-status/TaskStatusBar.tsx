/**
 * 任务页顶部状态条（2026-10-26 从 TaskPanel 抽出）：
 * 工作区路径、模型与思考强度菜单、本次费用、账户余额。
 */
import type { ReactElement } from 'react'
import type { AgentLlmStatus } from '../../../../electron/ipc/channels'
import { formatCost, formatWorkspacePath } from '../../shared/format-value'
import type { ThinkingNotice } from './useTaskStatus'

const THINKING_MENU_LABELS: Record<string, string> = {
  low: 'low · 省 token',
  high: 'high · 默认',
  max: 'max · 复杂任务'
}

export interface TaskStatusBarProps {
  workspace: string
  llmStatus: AgentLlmStatus | null
  refreshingLlm: boolean
  thinkingOpen: boolean
  savingThinking: boolean
  thinkingNotice: ThinkingNotice | null
  thinkingRef: React.MutableRefObject<HTMLDivElement | null>
  activeModel: string
  modelTitle: string
  taskCost: number
  balanceText: string
  balanceTitle: string
  balanceLow: boolean
  balanceStale: boolean
  onToggleThinking: () => void
  onChooseThinking: (level: string) => void
  onRefresh: () => void
}

export default function TaskStatusBar({
  workspace,
  llmStatus,
  refreshingLlm,
  thinkingOpen,
  savingThinking,
  thinkingNotice,
  thinkingRef,
  activeModel,
  modelTitle,
  taskCost,
  balanceText,
  balanceTitle,
  balanceLow,
  balanceStale,
  onToggleThinking,
  onChooseThinking,
  onRefresh
}: TaskStatusBarProps): ReactElement {
  return (
    <div className="task-head-meta">
      {workspace ? (
        <span className="task-workspace" title={workspace}>
          {formatWorkspacePath(workspace)}
        </span>
      ) : null}
      {llmStatus?.showModel && activeModel ? (
        <div className="task-thinking" ref={thinkingRef}>
          {llmStatus.thinkingLevels.length > 0 ? (
            <button
              type="button"
              className="task-model task-thinking-btn"
              title={`${modelTitle}；思考强度 ${llmStatus.thinkingLevel}（点击切换，下次新任务生效）`}
              aria-haspopup="menu"
              aria-expanded={thinkingOpen}
              onClick={onToggleThinking}
            >
              <span>{activeModel}</span>
              <span className="task-thinking-level">· {llmStatus.thinkingLevel}</span>
              <span className="task-thinking-caret" aria-hidden="true">
                ▾
              </span>
            </button>
          ) : (
            <span className="task-model task-model-static" title={modelTitle}>
              {activeModel}
            </span>
          )}
          {thinkingOpen ? (
            <div className="task-thinking-menu" role="menu">
              <div className="task-thinking-menu-head">思考强度 · 下次新任务生效</div>
              {llmStatus.thinkingLevels.map((level) => (
                <button
                  key={level}
                  type="button"
                  role="menuitemradio"
                  aria-checked={level === llmStatus.thinkingLevel}
                  className={`task-thinking-item${
                    level === llmStatus.thinkingLevel ? ' task-thinking-item-active' : ''
                  }`}
                  disabled={savingThinking}
                  onClick={() => onChooseThinking(level)}
                >
                  <span>{THINKING_MENU_LABELS[level] ?? level}</span>
                  {level === llmStatus.thinkingLevel ? (
                    <span className="task-thinking-check">✓</span>
                  ) : null}
                </button>
              ))}
            </div>
          ) : null}
          {thinkingNotice ? (
            <span
              className={`task-thinking-note${
                thinkingNotice.error ? ' task-thinking-note-error' : ''
              }`}
              role="status"
            >
              {thinkingNotice.text}
            </span>
          ) : null}
        </div>
      ) : null}
      {llmStatus?.showCost && taskCost > 0 ? (
        <span
          className="task-cost"
          title="按 DeepSeek 官方价估算的本次任务累计费用（高峰/低谷自动折算）"
        >
          本次 ≈{formatCost(taskCost)}
        </span>
      ) : null}
      {llmStatus?.showBalance ? (
        <button
          type="button"
          className={`task-balance${balanceLow ? ' task-balance-low' : ''}${
            balanceStale ? ' task-balance-stale' : ''
          }${refreshingLlm ? ' task-balance-busy' : ''}`}
          title={balanceTitle}
          aria-label="刷新账户余额"
          aria-busy={refreshingLlm}
          onClick={onRefresh}
        >
          {balanceText}
          <span className="task-balance-refresh" aria-hidden="true">
            ↻
          </span>
        </button>
      ) : null}
    </div>
  )
}
