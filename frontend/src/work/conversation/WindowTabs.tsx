/** 标题栏下的标签行：对话 / 任务 / 网页标签 + 「+N」溢出菜单。 */
import type { ReactElement } from 'react'
import type { WorkBrowserTab } from '../../../electron/ipc/channels'
import { hostOf } from './format'

export interface WindowTabsProps {
  visibleTabs: WorkBrowserTab[]
  hiddenTabs: WorkBrowserTab[]
  activeId: string | null
  browsing: boolean
  taskOpen: boolean
  menuOpen: boolean
  onToggleMenu: () => void
  onChat: () => void
  onTask: () => void
  onActivate: (id: string) => void
  onClose: (id: string) => void
}

export default function WindowTabs({
  visibleTabs,
  hiddenTabs,
  activeId,
  browsing,
  taskOpen,
  menuOpen,
  onToggleMenu,
  onChat,
  onTask,
  onActivate,
  onClose
}: WindowTabsProps): ReactElement {
  return (
    <div className="work-tabs" role="tablist" aria-label="工作模式标签">
      <div className={`work-tab${browsing || taskOpen ? '' : ' work-tab-active'}`}>
        <button type="button" className="work-tab-main" onClick={onChat}>
          <span className="work-tab-title">对话</span>
        </button>
      </div>
      <div className={`work-tab${taskOpen ? ' work-tab-active' : ''}`}>
        <button type="button" className="work-tab-main" onClick={onTask}>
          <span className="work-tab-title">任务</span>
        </button>
      </div>
      {visibleTabs.map((tab) => (
        <div
          key={tab.id}
          className={`work-tab${activeId === tab.id ? ' work-tab-active' : ''}`}
          title={tab.url}
        >
          <button
            type="button"
            className="work-tab-main"
            onClick={() => onActivate(tab.id)}
          >
            {tab.loading ? <span className="work-tab-spinner" aria-hidden="true" /> : null}
            <span className="work-tab-title">{tab.title || hostOf(tab.url)}</span>
          </button>
          <button
            type="button"
            className="work-tab-close"
            aria-label={`关闭 ${tab.title}`}
            onClick={() => onClose(tab.id)}
          >
            ×
          </button>
        </div>
      ))}
      {hiddenTabs.length > 0 ? (
        <div className="work-tab-more-wrap" onPointerDown={(event) => event.stopPropagation()}>
          <button
            type="button"
            className={`work-tab-more${
              hiddenTabs.some((tab) => tab.id === activeId) ? ' work-tab-active' : ''
            }`}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={onToggleMenu}
          >
            +{hiddenTabs.length} ▾
          </button>
          {menuOpen ? (
            <div
              className="work-tabs-menu"
              role="menu"
              onPointerDown={(event) => event.stopPropagation()}
            >
              {hiddenTabs.map((tab) => (
                <div className="work-tabs-menu-row" key={tab.id}>
                  <button
                    type="button"
                    role="menuitem"
                    className="work-tabs-menu-main"
                    onClick={() => onActivate(tab.id)}
                  >
                    {tab.title || hostOf(tab.url)}
                  </button>
                  <button
                    type="button"
                    className="work-tabs-menu-close"
                    aria-label={`关闭 ${tab.title}`}
                    onClick={() => onClose(tab.id)}
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
