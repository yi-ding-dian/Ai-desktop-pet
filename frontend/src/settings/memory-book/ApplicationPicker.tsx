/**
 * 「从已安装应用中选择」内联面板（settings 域，2026-10-19）。
 *
 * 数据来自主进程 launcher 域（Windows 开始菜单 `.lnk` / Linux XDG `.desktop`）：
 * - 只显示可用条目；终端应用 / wrapper（flatpak/snap/env）/ 失效条目禁用并标注原因；
 * - 带字面参数的应用允许回填，但提示"单独运行可能不完整"；
 * - 点选后由 MemoryBookPanel 回填名字 + 可执行文件绝对路径（kind=program）。
 *
 * 旧 preload 没有 `launcher.listApps` 时显示手动填写提示，不阻断使用。
 */
import { useEffect, useMemo, useState, type ReactElement } from 'react'
import type { LauncherAppEntry } from '../../../electron/ipc/channels'
import { getPetBridge } from '../../shared/pet-bridge'

export interface ApplicationPickerProps {
  onPick: (app: LauncherAppEntry) => void
  onClose: () => void
}

/** 条目不可回填的原因（null = 可回填） */
function disabledReason(app: LauncherAppEntry): string | null {
  if (!app.available || !app.execPath) return '程序文件失效'
  if (app.needsTerminal) return '终端应用'
  if (app.wrapper) return '需通过应用菜单启动'
  return null
}

export default function ApplicationPicker({
  onPick,
  onClose
}: ApplicationPickerProps): ReactElement {
  const [apps, setApps] = useState<LauncherAppEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const [reloadToken, setReloadToken] = useState(0)

  useEffect(() => {
    let cancelled = false
    const launcher = getPetBridge().launcher
    if (!launcher?.listApps) {
      setLoading(false)
      setError('当前版本不支持自动读取已安装应用，请手动填写可执行文件路径。')
      return
    }
    setLoading(true)
    setError('')
    launcher
      .listApps({ refresh: reloadToken > 0 })
      .then((result) => {
        if (cancelled) return
        if (!result.ok) {
          setApps([])
          setError(result.message || '读取已安装应用失败。')
          return
        }
        setApps(result.apps)
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(`读取已安装应用失败：${String(err)}`)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [reloadToken])

  const filtered = useMemo(() => {
    const keyword = query.trim().toLowerCase()
    const list = keyword
      ? apps.filter(
          (app) =>
            app.name.toLowerCase().includes(keyword) ||
            app.id.toLowerCase().includes(keyword) ||
            app.execPath.toLowerCase().includes(keyword)
        )
      : apps
    return list.slice(0, 200)
  }, [apps, query])

  return (
    <div className="memory-book-picker" role="region" aria-label="选择已安装应用">
      <div className="memory-book-picker-head">
        <span className="memory-book-picker-title">已安装应用（{apps.length}）</span>
        <input
          className="memory-book-picker-search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索应用名或路径"
          aria-label="搜索应用"
        />
        <button
          type="button"
          className="pui-btn pui-btn-sm"
          disabled={loading}
          onClick={() => setReloadToken((value) => value + 1)}
        >
          刷新
        </button>
        <button type="button" className="pui-btn pui-btn-sm" onClick={onClose}>
          收起
        </button>
      </div>

      {loading ? (
        <div className="memory-book-picker-hint">正在读取已安装应用…</div>
      ) : error ? (
        <div className="memory-book-picker-hint memory-book-picker-error">{error}</div>
      ) : filtered.length === 0 ? (
        <div className="memory-book-picker-hint">
          {query.trim() ? '没有匹配的应用。' : '没有读到已安装应用，可以手动填写路径。'}
        </div>
      ) : (
        <ul className="memory-book-picker-list">
          {filtered.map((app) => {
            const reason = disabledReason(app)
            const extra =
              !reason && app.hasArgs
                ? '带启动参数，单独运行可能不完整'
                : ''
            return (
              <li key={app.id}>
                <button
                  type="button"
                  className="memory-book-picker-item"
                  disabled={Boolean(reason)}
                  title={app.execPath || app.id}
                  onClick={() => onPick(app)}
                >
                  <span className="memory-book-picker-name">{app.name}</span>
                  <span className="memory-book-picker-path">{app.execPath || app.id}</span>
                  {reason || extra ? (
                    <span className="memory-book-picker-badge">{reason || extra}</span>
                  ) : null}
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
