/**
 * 任务页顶部模型状态（2026-10-26 从 TaskPanel 抽出）。
 *
 * 负责：模型/余额状态、手动刷新、思考强度切换与「下次生效」提示。
 * 余额刷新失败保持旧值（软功能）；提示 2.5s 后自动消失（错误 4s）。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { AgentLlmStatus, AgentState } from '../../../../electron/ipc/channels'
import { formatMoney } from '../../shared/format-value'
import { agentBridge } from '../agent-bridge'
import { errorText } from '../error-text'

export interface ThinkingNotice {
  text: string
  error: boolean
}

export interface TaskStatusControls {
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
  refreshLlmStatus: () => Promise<void>
  chooseThinkingLevel: (level: string) => Promise<void>
  toggleThinking: () => void
  onLlmStatus: (status: AgentLlmStatus) => void
}

export function useTaskStatus(state: AgentState | null): TaskStatusControls {
  const [llmStatus, setLlmStatus] = useState<AgentLlmStatus | null>(null)
  const [refreshingLlm, setRefreshingLlm] = useState(false)
  /** 思考强度菜单 / 保存中 / 「下次生效」提示 */
  const [thinkingOpen, setThinkingOpen] = useState(false)
  const [savingThinking, setSavingThinking] = useState(false)
  const [thinkingNotice, setThinkingNotice] = useState<ThinkingNotice | null>(null)
  const thinkingRef = useRef<HTMLDivElement | null>(null)
  const thinkingNoticeTimer = useRef<number | null>(null)

  /** 手动刷新余额（10 分钟自动刷新由主进程负责） */
  const refreshLlmStatus = useCallback(async (): Promise<void> => {
    const api = agentBridge()
    if (!api || refreshingLlm) return
    setRefreshingLlm(true)
    try {
      setLlmStatus(await api.refreshLlmStatus())
    } catch {
      /* 余额是软功能：失败保持旧值 */
    } finally {
      setRefreshingLlm(false)
    }
  }, [refreshingLlm])

  const showThinkingNotice = useCallback((text: string, error = false): void => {
    if (thinkingNoticeTimer.current !== null) {
      window.clearTimeout(thinkingNoticeTimer.current)
    }
    setThinkingNotice({ text, error })
    thinkingNoticeTimer.current = window.setTimeout(
      () => {
        thinkingNoticeTimer.current = null
        setThinkingNotice(null)
      },
      error ? 4_000 : 2_500
    )
  }, [])

  useEffect(
    () => () => {
      if (thinkingNoticeTimer.current !== null) {
        window.clearTimeout(thinkingNoticeTimer.current)
        thinkingNoticeTimer.current = null
      }
    },
    []
  )

  // 思考强度菜单：点外面 / Esc 关闭
  useEffect(() => {
    if (!thinkingOpen) return
    const onPointerDown = (event: PointerEvent): void => {
      if (!thinkingRef.current?.contains(event.target as Node)) setThinkingOpen(false)
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setThinkingOpen(false)
    }
    window.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [thinkingOpen])

  /** 切换下次新任务的思考强度（当前任务不变） */
  const chooseThinkingLevel = useCallback(
    async (level: string): Promise<void> => {
      const api = agentBridge()
      const current = llmStatus?.thinkingLevel
      setThinkingOpen(false)
      if (!api || savingThinking || !current || level === current) return
      setSavingThinking(true)
      try {
        const result = await api.setThinkingLevel(level as 'low' | 'high' | 'max')
        if (!result.ok) showThinkingNotice(result.error ?? '切换失败', true)
        else showThinkingNotice('下次新任务生效')
      } catch (err) {
        showThinkingNotice(errorText(err), true)
      } finally {
        setSavingThinking(false)
      }
    },
    [llmStatus?.thinkingLevel, savingThinking, showThinkingNotice]
  )

  const toggleThinking = useCallback((): void => setThinkingOpen((open) => !open), [])

  const activeModel = state?.model || llmStatus?.model || ''
  const modelTitle = state?.model ? '当前任务使用的模型' : '当前配置的模型'
  const taskCost = state?.usage.cost ?? 0
  const balanceTotal = llmStatus?.total ?? null
  const balanceText = !llmStatus
    ? '余额 …'
    : balanceTotal === null
      ? refreshingLlm
        ? '余额 …'
        : '余额 —'
      : `余额 ${formatMoney(balanceTotal, llmStatus.currency)}`
  const balanceStale = Boolean(llmStatus?.code)
  const balanceLow =
    balanceTotal !== null &&
    (llmStatus?.currency ?? '').toUpperCase() === 'CNY' &&
    balanceTotal < 5
  const balanceTitle = [
    balanceTotal !== null && llmStatus
      ? `余额 ${formatMoney(balanceTotal, llmStatus.currency)}` +
        (llmStatus.toppedUp !== null || llmStatus.granted !== null
          ? `（充值 ${
              llmStatus.toppedUp !== null
                ? formatMoney(llmStatus.toppedUp, llmStatus.currency)
                : '—'
            } / 赠送 ${
              llmStatus.granted !== null
                ? formatMoney(llmStatus.granted, llmStatus.currency)
                : '—'
            }）`
          : '')
      : '',
    llmStatus?.message ?? '',
    '每 10 分钟自动刷新，点击立即刷新'
  ]
    .filter((line) => line.length > 0)
    .join('\n')

  return {
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
    refreshLlmStatus,
    chooseThinkingLevel,
    toggleThinking,
    onLlmStatus: setLlmStatus
  }
}
