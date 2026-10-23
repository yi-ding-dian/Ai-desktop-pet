/**
 * 编码任务步骤流面板（2026-10-23）。
 *
 * 数据来自主进程的整份状态快照（coding:state），本组件不维护增量合并：
 * - 任务进行中：显示最近步骤、状态、工作区，可中止；
 * - 任务结束：保留结果供回看，可手动收起；
 * - 未开始过任务（idle）时不渲染。
 */
import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import type { CodingState, CodingStatus, CodingStep } from '../../electron/ipc/channels'
import { getPetBridge } from '../shared/pet-bridge'

const STATUS_LABEL: Record<CodingStatus, string> = {
  idle: '空闲',
  starting: '启动中',
  running: '进行中',
  waiting: '等你确认',
  done: '已完成',
  cancelled: '已中止',
  error: '失败'
}

/** 面板最多渲染多少条步骤（主进程已限制总数） */
const MAX_RENDER_STEPS = 200
/** 单条 detail 渲染上限 */
const MAX_DETAIL_CHARS = 600

function codingBridge(): ReturnType<typeof getPetBridge>['coding'] | undefined {
  try {
    return getPetBridge().coding
  } catch {
    return undefined
  }
}

function stepDetail(step: CodingStep): string {
  const detail = step.detail ?? ''
  return detail.length > MAX_DETAIL_CHARS ? `${detail.slice(0, MAX_DETAIL_CHARS)}…` : detail
}

function StepRow({ step }: { step: CodingStep }): ReactElement {
  const [open, setOpen] = useState(false)
  const detail = stepDetail(step)
  const expandable = step.kind === 'thought' || (detail.length > 80 && step.kind !== 'message')
  return (
    <li className={`coding-step coding-step-${step.kind} coding-step-${step.status}`}>
      <span className={`coding-dot coding-dot-${step.status}`} aria-hidden="true" />
      <div className="coding-step-body">
        <div className="coding-step-title">
          <span className="coding-step-name">{step.title}</span>
          {expandable ? (
            <button
              type="button"
              className="coding-step-toggle"
              onClick={() => setOpen((value) => !value)}
            >
              {open ? '收起' : '详情'}
            </button>
          ) : null}
        </div>
        {detail ? (
          open || !expandable ? (
            <pre className="coding-step-detail">{detail}</pre>
          ) : null
        ) : null}
      </div>
    </li>
  )
}

export default function CodingPanel(): ReactElement | null {
  const [state, setState] = useState<CodingState | null>(null)
  const [collapsed, setCollapsed] = useState(false)
  const listRef = useRef<HTMLUListElement | null>(null)

  useEffect(() => {
    const bridge = codingBridge()
    if (!bridge) return
    let alive = true
    void bridge.getState().then((snapshot) => {
      if (alive) setState(snapshot)
    })
    const off = bridge.onState((snapshot) => {
      if (alive) setState(snapshot)
    })
    return () => {
      alive = false
      off()
    }
  }, [])

  const steps = useMemo(
    () => (state?.steps ?? []).slice(-MAX_RENDER_STEPS),
    [state?.steps]
  )
  // 最后一条文本长度也纳入滚动依赖：流式输出时步骤数不变但内容在长
  const lastDetailLength = steps.length
    ? (steps[steps.length - 1].detail ?? '').length
    : 0

  // 新内容到达时滚到底部（只有展开时）
  useEffect(() => {
    if (collapsed) return
    const list = listRef.current
    if (!list) return
    list.scrollTop = list.scrollHeight
  }, [steps.length, lastDetailLength, collapsed])

  if (!state || state.status === 'idle') return null

  const active =
    state.status === 'starting' ||
    state.status === 'running' ||
    state.status === 'waiting'

  return (
    <section className={`coding-panel${collapsed ? ' coding-panel-collapsed' : ''}`}>
      <header className="coding-head">
        <span className={`coding-badge coding-badge-${state.status}`}>
          {STATUS_LABEL[state.status]}
        </span>
        <span className="coding-task" title={state.task}>
          {state.task || '编码任务'}
        </span>
        <span className="coding-workspace" title={state.workspace}>
          {state.workspace}
        </span>
        <span className="coding-head-actions">
          {active ? (
            <button
              type="button"
              className="coding-btn coding-btn-stop"
              onClick={() => {
                void codingBridge()?.cancel()
              }}
            >
              中止
            </button>
          ) : null}
          <button
            type="button"
            className="coding-btn"
            onClick={() => setCollapsed((value) => !value)}
          >
            {collapsed ? '展开' : '收起'}
          </button>
        </span>
      </header>

      {collapsed ? null : (
        <div className="coding-body">
          {state.error ? <div className="coding-error">{state.error}</div> : null}
          {state.summary && !state.error ? (
            <div className="coding-summary">{state.summary}</div>
          ) : null}
          <ul className="coding-steps pui-scroll" ref={listRef}>
            {steps.map((step) => (
              <StepRow key={step.id} step={step} />
            ))}
          </ul>
        </div>
      )}
    </section>
  )
}
