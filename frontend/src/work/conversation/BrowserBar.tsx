/** 内嵌网页的后退/前进/刷新/地址条。 */
import type { ReactElement } from 'react'
import type { WorkBrowserAction, WorkBrowserTab } from '../../../electron/ipc/channels'

export default function BrowserBar({
  tab,
  canGoBack,
  canGoForward,
  onAction
}: {
  tab?: WorkBrowserTab
  canGoBack: boolean
  canGoForward: boolean
  onAction: (action: WorkBrowserAction) => void
}): ReactElement {
  return (
    <div className="work-browser-bar">
      <button
        type="button"
        className="work-browser-btn"
        disabled={!canGoBack}
        aria-label="后退"
        title="后退"
        onClick={() => onAction('back')}
      >
        ‹
      </button>
      <button
        type="button"
        className="work-browser-btn"
        disabled={!canGoForward}
        aria-label="前进"
        title="前进"
        onClick={() => onAction('forward')}
      >
        ›
      </button>
      <button
        type="button"
        className="work-browser-btn"
        aria-label="刷新"
        title="刷新"
        onClick={() => onAction('reload')}
      >
        ↻
      </button>
      <span className="work-browser-url" title={tab?.url ?? ''}>
        {tab?.url ?? ''}
      </span>
      {tab?.error ? (
        <span className="work-browser-error" title={tab.error}>
          加载失败
        </span>
      ) : null}
      <button
        type="button"
        className="work-browser-btn"
        aria-label="在系统浏览器打开"
        title="在系统浏览器打开"
        onClick={() => onAction('external')}
      >
        ↗
      </button>
    </div>
  )
}
