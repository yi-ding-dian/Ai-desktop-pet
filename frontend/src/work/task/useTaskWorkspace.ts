/**
 * 任务工作区（2026-10-26 从 TaskPanel 抽出）。
 *
 * 负责：默认工作区加载、路径校验（400ms 防抖 + 请求序号防串结果）、
 * 选择目录、设为默认。页面级错误提示通过 onError 回调（清空传 null）。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { agentBridge } from './agent-bridge'
import { errorText } from './error-text'

export interface WorkspaceCheck {
  status: 'checking' | 'valid' | 'invalid'
  error: string | null
}

export interface TaskWorkspaceOptions {
  /** 页面通用错误提示（清空传 null） */
  onError: (message: string | null) => void
}

export interface TaskWorkspaceControls {
  workspace: string
  setWorkspace: (path: string) => void
  workspaceCheck: WorkspaceCheck
  wsNotice: string | null
  /** 清掉 400ms 防抖的待校验定时器（开始任务前调用） */
  clearWsTimer: () => void
  checkWorkspace: (raw: string) => Promise<boolean>
  ensureWorkspace: () => Promise<boolean>
  handleWorkspaceChange: (value: string) => void
  handleWorkspaceBlur: () => void
  pickWorkspace: () => Promise<void>
  setWorkspaceAsDefault: () => Promise<void>
}

export function useTaskWorkspace({
  onError
}: TaskWorkspaceOptions): TaskWorkspaceControls {
  const [workspace, setWorkspace] = useState('')
  const [workspaceCheck, setWorkspaceCheck] = useState<WorkspaceCheck>({
    status: 'checking',
    error: null
  })
  const wsTimerRef = useRef<number | null>(null)
  /** 校验请求序号：输入变化后旧请求的结果直接丢弃 */
  const wsSeqRef = useRef(0)
  const [wsNotice, setWsNotice] = useState<string | null>(null)

  const clearWsTimer = useCallback((): void => {
    if (wsTimerRef.current === null) return
    window.clearTimeout(wsTimerRef.current)
    wsTimerRef.current = null
  }, [])

  useEffect(() => () => clearWsTimer(), [clearWsTimer])

  // 默认工作区：新任务每次从这里开始；配置无效 → 行内提示，不静默换目录
  useEffect(() => {
    const api = agentBridge()
    if (!api?.getDefaultWorkspace) {
      setWorkspaceCheck({ status: 'invalid', error: '任务模式不可用：请重启应用' })
      return
    }
    let alive = true
    void api
      .getDefaultWorkspace()
      .then((path) => {
        if (!alive) return
        setWorkspace(path)
        // 主进程解析默认工作区时已经做过存在性/目录校验
        setWorkspaceCheck({ status: 'valid', error: null })
      })
      .catch((err) => {
        if (!alive) return
        setWorkspaceCheck({ status: 'invalid', error: errorText(err) })
      })
    return () => {
      alive = false
    }
  }, [])

  /** 校验工作区（与主进程 agentService.start 同一套规则）；返回是否可用 */
  const checkWorkspace = useCallback(async (raw: string): Promise<boolean> => {
    const api = agentBridge()
    const text = raw.trim()
    if (!api) {
      setWorkspaceCheck({ status: 'invalid', error: '任务模式不可用：请重启应用' })
      return false
    }
    if (!text) {
      wsSeqRef.current += 1
      setWorkspaceCheck({ status: 'invalid', error: '工作区不能为空' })
      return false
    }
    const seq = wsSeqRef.current + 1
    wsSeqRef.current = seq
    setWorkspaceCheck({ status: 'checking', error: null })
    try {
      const result = await api.validateWorkspace(text)
      if (wsSeqRef.current !== seq) return false
      if (result.ok) {
        setWorkspaceCheck({ status: 'valid', error: null })
        return true
      }
      setWorkspaceCheck({ status: 'invalid', error: result.error ?? '工作区不可用' })
      return false
    } catch (err) {
      if (wsSeqRef.current !== seq) return false
      setWorkspaceCheck({ status: 'invalid', error: errorText(err) })
      return false
    }
  }, [])

  /** 输入路径：去资源管理器「复制为路径」带的首尾引号，400ms 防抖校验 */
  const handleWorkspaceChange = useCallback(
    (value: string): void => {
      const trimmed = value.trim()
      const next =
        trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')
          ? trimmed.slice(1, -1)
          : value
      setWorkspace(next)
      onError(null)
      clearWsTimer()
      wsSeqRef.current += 1 // 让在途的旧校验结果失效
      if (!next.trim()) {
        setWorkspaceCheck({ status: 'invalid', error: '工作区不能为空' })
        return
      }
      setWorkspaceCheck({ status: 'checking', error: null })
      wsTimerRef.current = window.setTimeout(() => {
        wsTimerRef.current = null
        void checkWorkspace(next)
      }, 400)
    },
    [checkWorkspace, clearWsTimer, onError]
  )

  const handleWorkspaceBlur = useCallback((): void => {
    clearWsTimer()
    void checkWorkspace(workspace)
  }, [checkWorkspace, clearWsTimer, workspace])

  /** 开始/设为默认前的兜底：valid 直接用，否则现场校验 */
  const ensureWorkspace = useCallback(async (): Promise<boolean> => {
    if (workspaceCheck.status === 'valid') return true
    return checkWorkspace(workspace)
  }, [checkWorkspace, workspace, workspaceCheck.status])

  /** 手动选目录：只对当前草稿生效；要长期使用需另点「设为默认」 */
  const pickWorkspace = useCallback(async (): Promise<void> => {
    const api = agentBridge()
    if (!api) return
    try {
      const picked = await api.pickWorkspace()
      if (!picked) return
      clearWsTimer()
      wsSeqRef.current += 1
      setWorkspace(picked)
      onError(null)
      void checkWorkspace(picked)
    } catch (err) {
      onError(errorText(err))
    }
  }, [checkWorkspace, clearWsTimer, onError])

  /** 把当前目录写回 config.toml，下次新任务仍从这里开始 */
  const setWorkspaceAsDefault = useCallback(async (): Promise<void> => {
    const api = agentBridge()
    const target = workspace.trim()
    if (!api || !target) return
    clearWsTimer()
    if (!(await ensureWorkspace())) return
    try {
      const result = await api.setDefaultWorkspace(target)
      if (!result.ok) {
        setWorkspaceCheck({
          status: 'invalid',
          error: result.error ?? '保存默认工作区失败'
        })
        return
      }
    } catch (err) {
      setWorkspaceCheck({ status: 'invalid', error: errorText(err) })
      return
    }
    setWsNotice(`已把「${target}」设为默认工作区`)
    window.setTimeout(() => setWsNotice(null), 4000)
  }, [workspace, ensureWorkspace, clearWsTimer])

  return {
    workspace,
    setWorkspace,
    workspaceCheck,
    wsNotice,
    clearWsTimer,
    checkWorkspace,
    ensureWorkspace,
    handleWorkspaceChange,
    handleWorkspaceBlur,
    pickWorkspace,
    setWorkspaceAsDefault
  }
}
