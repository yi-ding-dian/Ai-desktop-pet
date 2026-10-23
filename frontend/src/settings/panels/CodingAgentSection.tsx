/**
 * 「编码代理」设置分区（2026-10-23）。
 *
 * 编码代理是独立的 DeepSeek Harness（dsh）运行时，不随小兔安装。这里提供：
 * - 检测：本机已装 / 版本过旧 / 只能靠 npx / 完全不可用；
 * - 一键安装到小兔自己的数据目录（用户级，不需要管理员，不污染全局 npm）；
 * - 安装进度流式展示、取消、卸载。
 *
 * 注意：编码代理使用 **dsh 自己的 API Key**，不是上面 LLM 分区里那个
 * （自动复用小兔 Key 是后续版本的事）。
 */
import { useEffect, useRef, useState, type ReactElement } from 'react'
import type {
  CodingInstallProgress,
  CodingInstallResult,
  CodingPreferences,
  CodingRuntimeStatus
} from '../../../electron/ipc/channels'
import { Button } from '../../shared/ui'
import { SwitchRow } from '../components/fields'
import Section from '../components/section'
import { getPetBridge } from '../../shared/pet-bridge'

const STATE_LABEL: Record<CodingRuntimeStatus['state'], string> = {
  ready: '已就绪',
  'npx-only': '未安装（可临时下载）',
  outdated: '版本过旧',
  unavailable: '不可用'
}

/** 安装日志最多保留多少行 */
const LOG_LIMIT = 8

function codingBridge(): ReturnType<typeof getPetBridge>['coding'] | undefined {
  try {
    return getPetBridge().coding
  } catch {
    return undefined
  }
}

export default function CodingAgentSection(): ReactElement {
  const [status, setStatus] = useState<CodingRuntimeStatus | null>(null)
  const [preferences, setPreferences] = useState<CodingPreferences | null>(null)
  const [detecting, setDetecting] = useState(false)
  const [installing, setInstalling] = useState(false)
  const [log, setLog] = useState<string[]>([])
  const [notice, setNotice] = useState<CodingInstallResult | null>(null)
  const aliveRef = useRef(true)

  const detect = async (): Promise<void> => {
    const bridge = codingBridge()
    if (!bridge?.detect) {
      setNotice({ ok: false, message: '这个版本还不支持检测编码代理。' })
      return
    }
    setDetecting(true)
    try {
      const result = await bridge.detect()
      if (aliveRef.current) setStatus(result)
    } catch (error) {
      if (aliveRef.current) {
        setNotice({
          ok: false,
          message: `检测失败：${error instanceof Error ? error.message : String(error)}`
        })
      }
    } finally {
      if (aliveRef.current) setDetecting(false)
    }
  }

  useEffect(() => {
    aliveRef.current = true
    void detect()
    const prefsPromise = codingBridge()?.getPreferences?.()
    if (prefsPromise) {
      void prefsPromise
        .then((prefs) => {
          if (aliveRef.current) setPreferences(prefs)
        })
        .catch(() => {
          // 旧 preload 没有这个方法：用默认值展示
          if (aliveRef.current) setPreferences({ reuseLlmKey: true })
        })
    }
    const off = codingBridge()?.onInstallProgress?.((progress: CodingInstallProgress) => {
      if (!aliveRef.current) return
      if (progress.phase === 'output') {
        if (progress.line) {
          setLog((lines) => [...lines, progress.line as string].slice(-LOG_LIMIT))
        }
        return
      }
      if (progress.phase === 'starting') {
        setInstalling(true)
        setLog([])
        setNotice(null)
        return
      }
      if (progress.phase === 'verifying' || progress.phase === 'done' || progress.phase === 'error' || progress.phase === 'cancelled') {
        if (progress.message) {
          setLog((lines) => [...lines, progress.message as string].slice(-LOG_LIMIT))
        }
      }
      if (progress.phase === 'done' || progress.phase === 'error' || progress.phase === 'cancelled') {
        setInstalling(false)
      }
    })
    return () => {
      aliveRef.current = false
      off?.()
    }
    // 只在挂载时跑一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const install = async (): Promise<void> => {
    const bridge = codingBridge()
    if (!bridge?.install) {
      setNotice({ ok: false, message: '这个版本还不支持安装编码代理。' })
      return
    }
    setInstalling(true)
    setNotice(null)
    setLog([])
    try {
      const result = await bridge.install()
      if (!aliveRef.current) return
      setNotice(result)
      if (result.status) setStatus(result.status)
    } catch (error) {
      if (aliveRef.current) {
        setNotice({
          ok: false,
          message: `安装失败：${error instanceof Error ? error.message : String(error)}`
        })
      }
    } finally {
      if (aliveRef.current) setInstalling(false)
    }
  }

  const cancelInstall = async (): Promise<void> => {
    const result = await codingBridge()?.cancelInstall?.()
    if (result) setNotice(result)
  }

  const uninstall = async (): Promise<void> => {
    const bridge = codingBridge()
    if (!bridge?.uninstall) return
    try {
      const result = await bridge.uninstall()
      if (!aliveRef.current) return
      setNotice(result)
      if (result.status) setStatus(result.status)
      else void detect()
    } catch (error) {
      if (aliveRef.current) {
        setNotice({
          ok: false,
          message: `卸载失败：${error instanceof Error ? error.message : String(error)}`
        })
      }
    }
  }

  const tone = status
    ? status.state === 'ready'
      ? 'ok'
      : status.state === 'npx-only'
        ? 'info'
        : 'fail'
    : 'info'

  return (
    <Section
      title="编码代理"
      desc="让宠物把写代码、改代码、跑测试的活交给 DeepSeek Harness。独立安装在小兔的数据目录（约 800MB，首次安装需几分钟），不污染系统 npm。"
    >
      <div className="set-coding-status">
        <span className={`set-coding-dot ${tone}`} aria-hidden="true" />
        <span className={`set-coding-state ${tone}`}>
          {status ? STATE_LABEL[status.state] : detecting ? '检测中…' : '未检测'}
        </span>
        <span className="set-coding-message">
          {status?.message ?? '点「检测」看看本机有没有可用的编码代理。'}
        </span>
      </div>

      {status ? (
        <div className="set-coding-meta">
          {status.version ? <span>版本 {status.version}</span> : null}
          {status.source !== 'none' && status.executable ? (
            <span title={status.executable}>来源：{status.source === 'app' ? '小兔安装' : status.source === 'path' ? '系统安装' : 'npx'}</span>
          ) : null}
          <span title={status.runtimeDir}>目录：{status.runtimeDir}</span>
        </div>
      ) : null}

      <SwitchRow
        label="复用「LLM」里配置的 API Key"
        hint="启动编码任务时读取一次，只放进子进程环境变量；不落盘、不进日志。关闭则使用 dsh 自己的凭据。"
        checked={preferences?.reuseLlmKey ?? true}
        disabled={!preferences || installing}
        onCheckedChange={(checked) => {
          const bridge = codingBridge()
          if (!bridge?.setPreferences) return
          // 乐观更新，失败再回读
          setPreferences({ reuseLlmKey: checked })
          void bridge
            .setPreferences({ reuseLlmKey: checked })
            .then((next) => {
              if (aliveRef.current) setPreferences(next)
            })
            .catch(() => {
              void bridge.getPreferences?.().then((next) => {
                if (aliveRef.current) setPreferences(next)
              })
            })
        }}
      />

      <div className="pui-row pui-row-top">
        <Button onClick={() => void detect()} disabled={detecting || installing}>
          {detecting ? '检测中…' : '检测'}
        </Button>
        {installing ? (
          <Button onClick={() => void cancelInstall()}>取消安装</Button>
        ) : (
          <Button
            onClick={() => void install()}
            disabled={!status?.npmAvailable}
            title={!status?.npmAvailable ? '没找到 npm，请先安装 Node.js' : undefined}
          >
            {status?.runtimeInstalled
              ? '修复安装'
              : status?.state === 'ready'
                ? '安装到小兔目录'
                : '安装编码代理'}
          </Button>
        )}
        {status?.runtimeInstalled ? (
          <Button onClick={() => void uninstall()} disabled={installing}>
            卸载
          </Button>
        ) : null}
      </div>

      {!status?.npmAvailable && status ? (
        <p className="set-coding-hint">
          没找到 npm：请先安装 Node.js（<a className="set-key-link" href="https://nodejs.org/" target="_blank" rel="noreferrer noopener">nodejs.org</a>），或者自己在系统里安装 dsh。
        </p>
      ) : null}

      {notice ? (
        <p className={`set-test-result ${notice.ok ? 'ok' : 'fail'}`}>
          {notice.ok ? '✅ ' : '❌ '}
          {notice.message}
        </p>
      ) : null}

      {log.length > 0 ? (
        <pre className="set-coding-log">{log.join('\n')}</pre>
      ) : null}

      <p className="set-coding-hint">
        {preferences?.reuseLlmKey ?? true
          ? '编码代理会复用上面「LLM」分区里保存的 Key：改了那里的 Key 就同步生效，不需要单独配置 dsh。'
          : '编码代理会使用 dsh 自己的凭据，请在 dsh 里配置有效的 API Key。'}
        任务运行时每一步写文件/跑命令都会再弹气泡问你。
      </p>
    </Section>
  )
}
