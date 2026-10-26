/** 执行模式选择（2026-10-24）：标准 / 自动 / 计划。 */
import type { ReactElement } from 'react'
import type { ExecutionMode } from '../../../../electron/ipc/channels'

export const MODE_LABELS: Record<ExecutionMode, string> = {
  standard: '标准',
  auto: '自动',
  plan: '计划'
}

export const MODE_HINTS: Record<ExecutionMode, string> = {
  standard: '工作区内读/写/删免确认；工作区外写/删需确认；命令每次确认',
  auto: '除致命系统操作外全部自动执行',
  plan: '只读调研，只产出计划，不动文件不执行命令'
}

const MODES: ExecutionMode[] = ['standard', 'auto', 'plan']

export interface TaskModeSelectorProps {
  mode: ExecutionMode
  onChange: (mode: ExecutionMode) => void
  /** 紧凑版（任务 header 用） */
  compact?: boolean
  disabled?: boolean
}

export default function TaskModeSelector({
  mode,
  onChange,
  compact = false,
  disabled = false
}: TaskModeSelectorProps): ReactElement {
  return (
    <div
      className={`task-mode-switch${compact ? ' task-mode-switch-compact' : ''}`}
      role="group"
      aria-label="执行模式"
    >
      {MODES.map((item) => (
        <button
          key={item}
          type="button"
          className={`task-mode-option${item === mode ? ' task-mode-option-on' : ''}`}
          aria-pressed={item === mode}
          title={MODE_HINTS[item]}
          disabled={disabled}
          onClick={() => onChange(item)}
        >
          {MODE_LABELS[item]}
        </button>
      ))}
    </div>
  )
}
