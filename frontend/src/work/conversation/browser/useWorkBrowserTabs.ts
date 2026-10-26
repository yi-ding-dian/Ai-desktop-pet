/**
 * 工作窗内置浏览器标签（2026-10-26 从 WorkApp 抽出）。
 *
 * 负责：标签状态订阅、可见标签裁剪（最多 3 个，当前标签必须可见）、
 * 打开/关闭/切换/工具条动作、正文链接点击转新标签、溢出菜单开关。
 */
import { useCallback, useEffect, useMemo, useState, type MouseEvent as ReactMouseEvent } from 'react'
import type {
  WorkBrowserAction,
  WorkBrowserState,
  WorkBrowserTab
} from '../../../../electron/ipc/channels'
import { workBridge } from '../../work-bridge'

const EMPTY_BROWSER_STATE: WorkBrowserState = {
  tabs: [],
  activeId: null,
  canGoBack: false,
  canGoForward: false
}

/** 标签栏最多直接显示几个，超出进「+N」菜单 */
const VISIBLE_TAB_LIMIT = 3

export interface WorkBrowserTabsControls {
  browser: WorkBrowserState
  browsing: boolean
  activeTab: WorkBrowserTab | undefined
  visibleTabs: WorkBrowserTab[]
  hiddenTabs: WorkBrowserTab[]
  tabsMenuOpen: boolean
  setTabsMenuOpen: React.Dispatch<React.SetStateAction<boolean>>
  open: (url: string, label?: string) => void
  close: (id: string) => void
  activate: (id: string | null) => void
  action: (action: WorkBrowserAction) => void
  /** 正文链接点击 → 内嵌浏览器新标签；bridge 不可用时保持默认（主进程会走系统浏览器） */
  handleContentClick: (event: ReactMouseEvent<HTMLDivElement>) => void
}

export function useWorkBrowserTabs(): WorkBrowserTabsControls {
  const [browser, setBrowser] = useState<WorkBrowserState>(EMPTY_BROWSER_STATE)
  const [tabsMenuOpen, setTabsMenuOpen] = useState(false)

  // 主进程推送标签状态（打开/关闭/前进后退都走这里）
  useEffect(() => {
    const off = workBridge()?.onBrowserState?.((next) => setBrowser(next))
    return () => off?.()
  }, [])

  // 标签溢出菜单：点击空白 / Esc 关闭
  useEffect(() => {
    if (!tabsMenuOpen) return
    const close = (): void => setTabsMenuOpen(false)
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') close()
    }
    document.addEventListener('pointerdown', close)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', close)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [tabsMenuOpen])

  // +N 下拉菜单是 DOM，原生网页视图永远在 DOM 之上：菜单打开时临时隐藏视图
  useEffect(() => {
    workBridge()?.browserOverlay?.(tabsMenuOpen)
  }, [tabsMenuOpen])

  const browsing = browser.activeId !== null
  const activeTab = browser.tabs.find((tab) => tab.id === browser.activeId)
  const visibleTabs = useMemo(() => {
    const visible = browser.tabs.slice(0, VISIBLE_TAB_LIMIT)
    const active = browser.tabs.find((tab) => tab.id === browser.activeId)
    if (active !== undefined && !visible.some((tab) => tab.id === active.id)) {
      if (visible.length >= VISIBLE_TAB_LIMIT) visible[VISIBLE_TAB_LIMIT - 1] = active
      else visible.push(active)
    }
    return visible
  }, [browser.tabs, browser.activeId])
  const hiddenTabs = browser.tabs.filter(
    (tab) => !visibleTabs.some((item) => item.id === tab.id)
  )

  const open = useCallback((url: string, label?: string): void => {
    workBridge()?.browserOpen?.({ url, label })
  }, [])

  const close = useCallback((id: string): void => {
    workBridge()?.browserClose?.(id)
  }, [])

  const activate = useCallback((id: string | null): void => {
    workBridge()?.browserActivate?.(id)
  }, [])

  const action = useCallback((next: WorkBrowserAction): void => {
    workBridge()?.browserAction?.(next)
  }, [])

  const handleContentClick = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>): void => {
      const target = event.target as HTMLElement
      const anchor = target.closest('a')
      if (anchor === null) return
      const href = anchor.href
      if (!/^https?:\/\//i.test(href)) return
      if (!workBridge()?.browserOpen) return
      event.preventDefault()
      open(href, anchor.getAttribute('title') ?? undefined)
    },
    [open]
  )

  return {
    browser,
    browsing,
    activeTab,
    visibleTabs,
    hiddenTabs,
    tabsMenuOpen,
    setTabsMenuOpen,
    open,
    close,
    activate,
    action,
    handleContentClick
  }
}
