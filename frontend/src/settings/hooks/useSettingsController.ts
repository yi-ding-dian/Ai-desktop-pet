/**
 * 设置页控制器（settings 域 hooks 层）：数据流状态机（设计文档 §7.6.2）。
 *
 * 生命周期：
 *   mount → 建 SettingsBackendClient（自持 WS 连接）→ connected 后发 get_config
 *   → 收 `config` 填充表单（基线 = 服务端值）→ 用户编辑（dirty）→ 保存发 set_config{patch}
 *   → 收 `config` 回执 → 提示"已保存生效"并以回执为新基线。
 * 另有：「测试连接」（test_llm → llm_test_result）与 `error` 事件的就近归因
 * （按当前未决请求 pending 判断该错误属于加载/保存/测试，否则作为一般错误提示）。
 *
 * 简化取舍（第一版）：
 * - 请求-回执不做 reply_to 配对，用 pending 单槽状态机（单窗口单用户场景足够）；
 * - 超时兜底（加载/保存 15s、测试 40s）：超时给提示，不影响后续重试；
 * - 重连（后端重启）后自动重拉配置；若用户正有未保存改动，只更新基线不覆盖表单。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { getPetBridge } from '../../shared/pet-bridge'
import type { WsConnectionState } from '../../shared/ws-client'
import type { ConfigData } from '../../shared/protocol'
import {
  buildPatch,
  EMPTY_FORM,
  hasChanges,
  snapshotToForm,
  type FormValues
} from '../model/config-form'
import { parseQuietHours } from '../model/quiet-hours'
import { createSettingsBackendClient, type SettingsBackendClient } from '../api/config-client'

/** 加载阶段：waiting=等后端连接，loading=已发 get_config 等回执，ready=已填充 */
export type LoadPhase = 'waiting' | 'loading' | 'ready'

export interface TestResult {
  ok: boolean
  message: string
}

export interface Notice {
  kind: 'info' | 'success' | 'error'
  text: string
}

export interface SettingsController {
  connection: WsConnectionState
  loadPhase: LoadPhase
  form: FormValues
  dirty: boolean
  saving: boolean
  testing: boolean
  testResult: TestResult | null
  /** 「测试连接」成功拉到的模型列表（模型输入框切下拉的数据源） */
  models: string[] | null
  notice: Notice | null
  appVersion: string
  /** 免打扰时段字段的校验错误（提交前校验，定位到字段下方展示） */
  quietHoursError: string | null
  /** 配置快照版本号（每应用一次服务端 config 事件 +1；面板据此收起瞬态编辑态，如 Key 更新框） */
  revision: number
  /** 引导模式（首启引导 §7.6.5：首次加载时 llm.base_url 为空 → 显示欢迎条 + 自动切 LLM 分区） */
  guideMode: boolean
  /** 引导完成态：本次引导中「测试连接」成功过（欢迎条变成功文案 + 可关闭） */
  guideDone: boolean
  /** 关闭欢迎条 */
  dismissGuide(): void
  setField<K extends keyof FormValues>(key: K, value: FormValues[K]): void
  save(): void
  testConnection(): void
  restartApp(): void
}

/** 未决请求（用于把回执/错误归因到操作） */
type Pending = 'load' | 'save' | 'test' | null

const LOAD_TIMEOUT_MS = 15_000
const SAVE_TIMEOUT_MS = 15_000
const TEST_TIMEOUT_MS = 40_000

export function useSettingsController(): SettingsController {
  const clientRef = useRef<SettingsBackendClient | null>(null)

  const [connection, setConnection] = useState<WsConnectionState>('idle')
  const [loadPhase, setLoadPhase] = useState<LoadPhase>('waiting')
  const [form, setForm] = useState<FormValues>(EMPTY_FORM)
  const [baseline, setBaseline] = useState<FormValues>(EMPTY_FORM)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<TestResult | null>(null)
  const [models, setModels] = useState<string[] | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [appVersion, setAppVersion] = useState('')
  const [quietHoursError, setQuietHoursError] = useState<string | null>(null)
  const [revision, setRevision] = useState(0)
  const [guideMode, setGuideMode] = useState(false)
  const [guideDone, setGuideDone] = useState(false)
  /** 引导判定只做一次（首个配置快照到达时）；StrictMode 双挂载/外部快照不重复触发 */
  const guideEvaluatedRef = useRef(false)

  // 事件回调里读"最新值"的 ref 镜像（订阅一生只挂一次）
  const formRef = useRef(form)
  formRef.current = form
  const baselineRef = useRef(baseline)
  baselineRef.current = baseline
  const dirtyRef = useRef(false)
  const pendingRef = useRef<Pending>(null)
  const timerRef = useRef<number | null>(null)

  const dirty = useMemo(() => hasChanges(form, baseline), [form, baseline])
  dirtyRef.current = dirty

  // ---------------------------------------------------------------- 工具

  const clearTimer = useCallback((): void => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }, [])

  // 卸载时清掉未决请求的超时定时器
  useEffect(() => () => clearTimer(), [clearTimer])

  /** 未决请求超时兜底：给可读提示并复位对应状态 */
  const armTimer = useCallback(
    (kind: Exclude<Pending, null>): void => {
      clearTimer()
      const ms = kind === 'test' ? TEST_TIMEOUT_MS : kind === 'save' ? SAVE_TIMEOUT_MS : LOAD_TIMEOUT_MS
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null
        if (pendingRef.current !== kind) return
        pendingRef.current = null
        if (kind === 'save') {
          setSaving(false)
          setNotice({ kind: 'error', text: '保存超时：未收到后端回执（后端版本较旧或异常）' })
        } else if (kind === 'test') {
          setTesting(false)
          setTestResult({ ok: false, message: `测试超时（${TEST_TIMEOUT_MS / 1000}s 未收到结果）` })
        } else {
          setNotice({ kind: 'error', text: '获取配置超时：未收到后端回执' })
        }
      }, ms)
    },
    [clearTimer]
  )

  // ---------------------------------------------------------------- 事件处理

  const handleConfig = useCallback((config: ConfigData): void => {
    clearTimer()
    const kind = pendingRef.current
    pendingRef.current = null
    const next = snapshotToForm(config)
    setRevision((r) => r + 1) // 快照版本 +1（面板收起瞬态编辑态的依据）
    if (import.meta.env.DEV) {
      console.log(
        `[settings] config 事件（kind=${kind ?? '外部'}）：base_url=${next.llmBaseUrl || '-'} model=${next.llmModel || '-'} name=${next.petName || '-'}`
      )
    }

    if (kind === 'save') {
      setBaseline(next)
      setForm(next)
      setSaving(false)
      setQuietHoursError(null)
      setGuideMode(false) // 保存成功 → 欢迎条消失（首启引导 §7.6.5）
      setNotice({ kind: 'success', text: '已保存生效' })
      return
    }

    // 首启引导判定（只做一次）：base_url 为空 = 还没配过大脑 → 进入引导模式
    if (!guideEvaluatedRef.current) {
      guideEvaluatedRef.current = true
      if (next.llmBaseUrl.trim() === '') {
        setGuideMode(true)
        if (import.meta.env.DEV) console.log('[settings] llm.base_url 为空 → 进入首启引导模式')
      }
    }

    // 初次加载 / 重连后的刷新（kind === 'load'，或未预期快照）
    setLoadPhase('ready')
    setBaseline(next)
    // 用户此前已有未保存改动时不覆盖输入（后端重启等场景），只悄悄更新基线。
    // 注：用 formRef 快照比较后传"具体值"，而不是 setForm(updater) 内读 ref——
    // updater 必须是纯函数：StrictMode 会 double-invoke updater，读外部可变 ref
    // 会在两次调用间拿到不同时序的值，导致采用错误结果（踩过坑）。
    const edited = hasChanges(formRef.current, baselineRef.current)
    if (import.meta.env.DEV) {
      console.log(`[settings] 应用快照：用户已有改动=${edited}（保留输入=${edited}）`)
    }
    setForm(edited ? formRef.current : next)
    if (kind === 'load') setNotice({ kind: 'info', text: '配置已加载' })
  }, [clearTimer])

  useEffect(() => {
    const client = createSettingsBackendClient()
    clientRef.current = client

    const offConn = client.onConnectionChange((state) => {
      setConnection(state)
      if (import.meta.env.DEV) console.log(`[settings] WS 状态：${state}`)
      // 连接就绪（含后端重启后的重连）→ 拉配置。
      // 已有未决请求时不打断（极端时序：在途保存/测试恰好遇到重连）——该请求会走完
      // 回执，或由超时兜底复位；配置刷新留给下一次连接事件。
      if (state === 'connected' && pendingRef.current === null) {
        pendingRef.current = 'load'
        setLoadPhase((prev) => (prev === 'ready' ? prev : 'loading'))
        armTimer('load')
        if (!client.requestConfig()) {
          clearTimer()
          pendingRef.current = null
        }
      }
    })

    const offConfig = client.onConfig(handleConfig)

    const offTest = client.onTestResult((result) => {
      // 只消费"属于测试"的结果：若 pending 已是别的请求（理论上被单槽拒绝挡住），
      // 迟到的结果仍展示，但不碰 pending / 定时器，避免误清保存链路
      if (pendingRef.current === 'test') {
        clearTimer()
        pendingRef.current = null
      }
      setTesting(false)
      setTestResult({ ok: result.ok, message: result.message })
      if (result.ok) setGuideDone(true) // 引导模式中测试成功 → 欢迎条切成功态 + 可关闭
      const list = Array.isArray(result.models) ? result.models.filter((m) => typeof m === 'string') : []
      if (result.ok && list.length > 0) setModels(list)
    })

    const offError = client.onError((error) => {
      const kind = pendingRef.current
      clearTimer()
      pendingRef.current = null
      if (kind === 'save') {
        setSaving(false)
        setNotice({ kind: 'error', text: `保存失败：${error.message}` })
      } else if (kind === 'test') {
        setTesting(false)
        setTestResult({ ok: false, message: error.message })
      } else if (kind === 'load') {
        setNotice({ kind: 'error', text: `获取配置失败：${error.message}` })
      } else {
        setNotice({ kind: 'error', text: `后端错误：${error.message}` })
      }
    })

    // 补状态：订阅晚于连接建立（快照 Promise 先 resolve）时，补发一次 get_config
    if (client.connection === 'connected') {
      pendingRef.current = 'load'
      setLoadPhase('loading')
      armTimer('load')
      if (!client.requestConfig()) {
        clearTimer()
        pendingRef.current = null
      }
    }

    // 应用版本（关于分区；独立于 WS，bridge 缺失时静默）
    try {
      void getPetBridge()
        .backend?.getSnapshot?.()
        .then((snap) => setAppVersion(snap.appVersion || ''))
        .catch(() => {})
    } catch {
      /* 无 bridge（浏览器直开）：版本留空 */
    }

    return () => {
      offConn()
      offConfig()
      offTest()
      offError()
      clearTimer()
      client.dispose()
      clientRef.current = null
    }
  }, [armTimer, clearTimer, handleConfig])

  // 非错误提示 3s 后自动消失（错误保留给用户看）
  useEffect(() => {
    if (!notice || notice.kind === 'error') return
    const t = window.setTimeout(() => setNotice(null), 3000)
    return () => window.clearTimeout(t)
  }, [notice])

  // 有未保存改动时离开提示（简单实现：beforeunload 通用确认）
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent): void => {
      if (!dirtyRef.current) return
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [])

  // ---------------------------------------------------------------- 操作

  const setField = useCallback(
    <K extends keyof FormValues>(key: K, value: FormValues[K]): void => {
      setForm((prev) => ({ ...prev, [key]: value }))
      if (key === 'quietHoursText') setQuietHoursError(null)
    },
    []
  )

  const save = useCallback((): void => {
    const current = formRef.current
    const quiet = parseQuietHours(current.quietHoursText)
    if (!quiet.ok) {
      // 提交前校验：格式错误拦在这里（不使用户发出脏数据）
      setQuietHoursError(quiet.error)
      setNotice({ kind: 'error', text: '免打扰时段格式不对，请修正后再保存' })
      return
    }
    setQuietHoursError(null)

    const patch = buildPatch(current, baselineRef.current, quiet.list)
    if (!patch) return
    const client = clientRef.current
    if (!client) return
    // 单槽请求模型：同一时刻只允许一个未决请求（回执无类型标识，靠 pending 归因；
    // 允许重入会让后来的请求覆盖 pending，导致回执错配——如 load 回执被当成保存回执）
    if (pendingRef.current !== null) {
      setNotice({ kind: 'error', text: '上一个操作尚未完成，请稍候再保存' })
      return
    }

    pendingRef.current = 'save'
    setSaving(true)
    setNotice(null)
    if (!client.saveConfig(patch)) {
      pendingRef.current = null
      setSaving(false)
      setNotice({ kind: 'error', text: '连接未就绪，无法保存（等待后端连接）' })
      return
    }
    armTimer('save')
  }, [armTimer])

  const testConnection = useCallback((): void => {
    const current = formRef.current
    const baseUrl = current.llmBaseUrl.trim()
    const model = current.llmModel.trim()
    if (!baseUrl || !model) {
      setTestResult({ ok: false, message: '先填写 API 地址与模型，再测试连接' })
      return
    }
    const client = clientRef.current
    if (!client) return
    if (pendingRef.current !== null) {
      setTestResult({ ok: false, message: '上一个操作尚未完成，请稍候再测试' })
      return
    }

    pendingRef.current = 'test'
    setTesting(true)
    setTestResult(null)
    // key 输入为空时省略（后端用已保存的 key 测试）
    const key = current.llmKeyInput.trim()
    if (!client.testLlm({ base_url: baseUrl, model, key: key || null })) {
      pendingRef.current = null
      setTesting(false)
      setTestResult({ ok: false, message: '连接未就绪，无法测试（等待后端连接）' })
      return
    }
    armTimer('test')
  }, [armTimer])

  const restartApp = useCallback((): void => {
    try {
      getPetBridge().app?.restart?.()
      setNotice({ kind: 'info', text: '正在重启应用…' })
    } catch {
      setNotice({ kind: 'error', text: '重启不可用：pet-bridge 未就绪' })
    }
  }, [])

  const dismissGuide = useCallback((): void => {
    setGuideMode(false)
  }, [])

  return {
    connection,
    loadPhase,
    form,
    dirty,
    saving,
    testing,
    testResult,
    models,
    notice,
    appVersion,
    quietHoursError,
    revision,
    guideMode,
    guideDone,
    setField,
    save,
    testConnection,
    restartApp,
    dismissGuide
  }
}
