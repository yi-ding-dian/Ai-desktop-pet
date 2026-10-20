/**
 * 工作模式内嵌浏览器（2026-10-18）——WebContentsView 标签管理。
 *
 * 为什么不用 <iframe>/<webview>：
 *  - 大量站点有 X-Frame-Options/CSP，iframe 直接空白；
 *  - webview 已不推荐，安全边界也不如主进程持有的 WebContentsView 清楚。
 *
 * 设计：
 *  - 每个标签一个 WebContentsView，主进程创建/销毁；渲染面只画标题栏标签与工具条；
 *  - 视图放在标题栏（40）+ 浏览器工具条（34）下方，四周留 8px：
 *    露出窗口圆角，并保证 DOM 的四边/四角缩放热区不被原生视图盖住；
 *  - 临时会话（partition 无 persist: 前缀）：关闭应用不留 Cookie/登录态；
 *  - 远程页面按不可信处理：无 preload、无 Node、sandbox、权限全拒、弹窗转新标签；
 *  - 最多 6 个标签，超出时关闭最旧的**非当前**标签，避免内存无限增长。
 */
import {
  session,
  shell,
  WebContentsView,
  type BrowserWindow
} from 'electron'
import {
  IPC_WORK,
  WORK_BROWSER_INSET,
  WORK_BROWSER_TOOLBAR_HEIGHT,
  WORK_TITLEBAR_HEIGHT,
  type WorkBrowserAction,
  type WorkBrowserOpenPayload,
  type WorkBrowserState,
  type WorkBrowserTab
} from '../ipc/channels'

const MAX_TABS = 6
const PARTITION = 'work-browser'

/**
 * 注入到每个页面：普通左键链接改成 window.open(url, '_blank')，
 * 由 setWindowOpenHandler 统一转成新标签（用户定稿：页面内链接默认新标签）。
 * 页内锚点、下载、修饰键点击、target=_blank 保持浏览器默认行为。
 */
const LINK_INTERCEPT_SCRIPT = `(() => {
  if (window.__petWorkBrowserHooked) return
  window.__petWorkBrowserHooked = true
  document.addEventListener('click', (event) => {
    if (event.defaultPrevented || event.button !== 0) return
    if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return
    const anchor = event.target && event.target.closest ? event.target.closest('a[href]') : null
    if (!anchor) return
    if (anchor.hasAttribute('download')) return
    if (anchor.target && anchor.target !== '_self') return
    const href = anchor.href || ''
    if (!/^https?:\\/\\//i.test(href)) return
    const current = location.href.split('#')[0]
    if (href.split('#')[0] === current) return
    event.preventDefault()
    event.stopPropagation()
    window.open(href, '_blank')
  }, true)
})()`

interface Tab {
  id: string
  view: WebContentsView
  title: string
  url: string
  loading: boolean
  error?: string
}

function makeTabId(): string {
  return `t_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

export class WorkBrowser {
  private readonly win: BrowserWindow
  private readonly browserSession = session.fromPartition(PARTITION)
  private tabs: Tab[] = []
  private activeId: string | null = null
  /** DOM 浮层（标签溢出菜单）打开时临时隐藏原生视图 */
  private overlayOpen = false
  /** 窗口折叠成右缘角标（2026-10-20）：原生视图必须全隐藏，否则会盖住角标 UI */
  private foldedHidden = false

  constructor(win: BrowserWindow) {
    this.win = win

    // 权限全部拒绝（摄像头/麦克风/位置/通知…）；下载先取消，避免无 UI 的静默落盘
    this.browserSession.setPermissionRequestHandler((_wc, _permission, callback) => {
      callback(false)
    })
    this.browserSession.setPermissionCheckHandler(() => false)
    this.browserSession.on('will-download', (event, item) => {
      event.preventDefault()
      console.log(`[work-browser] 已拦截下载：${item.getFilename()}`)
    })

    const update = (): void => this.updateBounds()
    win.on('resize', update)
    win.on('show', () => this.applyVisibility())
    win.on('restore', () => this.applyVisibility())
    win.on('hide', () => this.setAllVisible(false))
    win.on('minimize', () => this.setAllVisible(false))
    win.on('closed', () => this.destroy())
  }

  /** 打开链接（同 URL 已有标签则直接切换） */
  open(payload: WorkBrowserOpenPayload): void {
    const raw = typeof payload?.url === 'string' ? payload.url.trim() : ''
    if (!isHttpUrl(raw)) return
    const url = new URL(raw).toString()

    const existing = this.tabs.find((tab) => tab.url === url)
    if (existing !== undefined) {
      this.activate(existing.id)
      return
    }

    if (this.tabs.length >= MAX_TABS) {
      const victim = this.tabs.find((tab) => tab.id !== this.activeId)
      if (victim === undefined) return
      this.close(victim.id)
    }

    const parsed = new URL(url)
    const label =
      (typeof payload.label === 'string' ? payload.label.trim() : '') || parsed.hostname

    const view = new WebContentsView({
      webPreferences: {
        partition: PARTITION,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webviewTag: false,
        spellcheck: false
      }
    })
    view.setBackgroundColor('#ffffff')
    this.win.contentView.addChildView(view)
    view.setVisible(false)

    // 去 Electron/应用标识，降低站点把内嵌页面当机器人拦截的概率
    const ua = view.webContents
      .getUserAgent()
      .replace(/\sElectron\/[\d.]+/g, '')
      .replace(/\sai-desktop-pet\/[\d.]+/gi, '')
    view.webContents.setUserAgent(ua)

    const tab: Tab = {
      id: makeTabId(),
      view,
      title: label,
      url,
      loading: true
    }
    this.tabs.push(tab)
    this.wire(tab)
    this.updateBounds()
    this.activate(tab.id)

    void view.webContents.loadURL(url).catch((err) => {
      console.warn(`[work-browser] 加载失败：${url}`, err)
    })
  }

  /** 关闭标签；关闭当前标签后切到相邻标签（没有则回对话） */
  close(id: string): void {
    const index = this.tabs.findIndex((tab) => tab.id === id)
    if (index < 0) return
    const [tab] = this.tabs.splice(index, 1)
    try {
      this.win.contentView.removeChildView(tab.view)
      tab.view.setVisible(false)
      tab.view.webContents.close()
    } catch (err) {
      console.warn('[work-browser] 关闭标签异常（忽略）：', err)
    }
    if (this.activeId === id) {
      const next = this.tabs[Math.min(index, this.tabs.length - 1)]
      this.activeId = next?.id ?? null
    }
    this.applyVisibility()
    this.emitState()
  }

  /** 切换标签；id=null 表示回到对话 */
  activate(id: string | null): void {
    if (id !== null && !this.tabs.some((tab) => tab.id === id)) return
    this.activeId = id
    this.applyVisibility()
    this.emitState()
  }

  /** 工具条动作（作用于当前标签） */
  action(action: WorkBrowserAction): void {
    const tab = this.tabs.find((item) => item.id === this.activeId)
    if (tab === undefined) return
    const wc = tab.view.webContents
    try {
      if (action === 'back' && wc.navigationHistory.canGoBack()) {
        wc.navigationHistory.goBack()
      } else if (action === 'forward' && wc.navigationHistory.canGoForward()) {
        wc.navigationHistory.goForward()
      } else if (action === 'reload') {
        wc.reload()
      } else if (action === 'external') {
        void shell.openExternal(tab.url)
      }
    } catch (err) {
      console.warn(`[work-browser] 动作 ${action} 失败：`, err)
    }
    this.emitState()
  }

  /** DOM 浮层打开时隐藏原生视图（原生视图永远在 DOM 之上，菜单会被它盖住） */
  setOverlay(open: boolean): void {
    this.overlayOpen = Boolean(open)
    this.applyVisibility()
  }

  /**
   * 折叠态：窗口缩成右缘小角标时隐藏全部原生视图（角标是渲染层 DOM，
   * 原生视图在它之上会整块盖住）；展开后恢复活动标签的显示。
   */
  setFolded(folded: boolean): void {
    this.foldedHidden = Boolean(folded)
    this.applyVisibility()
  }

  /** 供 work:ready / 渲染面重载后补一次状态 */
  sendState(): void {
    this.emitState()
  }

  destroy(): void {
    for (const tab of this.tabs) {
      try {
        if (!this.win.isDestroyed()) this.win.contentView.removeChildView(tab.view)
        tab.view.setVisible(false)
        tab.view.webContents.close()
      } catch {
        /* 窗口已销毁：忽略 */
      }
    }
    this.tabs = []
    this.activeId = null
  }

  // ---------------------------------------------------------------- 内部

  private wire(tab: Tab): void {
    const wc = tab.view.webContents

    wc.setWindowOpenHandler(({ url }) => {
      if (isHttpUrl(url)) this.open({ url })
      return { action: 'deny' }
    })

    wc.on('will-navigate', (event, url) => {
      // http(s) 由页面自身处理；其他协议一律拒绝（不把 file:/app: 等交给系统）
      if (!isHttpUrl(url)) event.preventDefault()
    })

    wc.on('dom-ready', () => {
      void wc.executeJavaScript(LINK_INTERCEPT_SCRIPT).catch((err) => {
        console.warn('[work-browser] 注入链接拦截失败：', err)
      })
    })

    wc.on('page-title-updated', (_event, title) => {
      const trimmed = title.trim()
      if (trimmed) tab.title = trimmed
      this.emitState()
    })
    wc.on('did-start-loading', () => {
      tab.loading = true
      delete tab.error
      this.emitState()
    })
    wc.on('did-stop-loading', () => {
      tab.loading = false
      this.emitState()
    })
    wc.on('did-navigate', (_event, url) => {
      tab.url = url
      this.emitState()
    })
    wc.on('did-navigate-in-page', (_event, url) => {
      tab.url = url
      this.emitState()
    })
    wc.on('did-fail-load', (_event, code, desc, _url, isMainFrame) => {
      if (!isMainFrame || code === -3) return // -3 = 主动中止（导航被替换）
      tab.loading = false
      tab.error = `${code} ${desc}`
      this.emitState()
    })
    wc.on('render-process-gone', (_event, details) => {
      tab.loading = false
      tab.error = `页面进程已退出（${details.reason}）`
      this.emitState()
    })
    // 页面自己调用 window.close() / webContents 被销毁：同步清掉标签，避免留空壳
    wc.on('destroyed', () => {
      if (this.tabs.some((item) => item.id === tab.id)) this.close(tab.id)
    })
  }

  private updateBounds(): void {
    if (this.win.isDestroyed()) return
    const [width, height] = this.win.getContentSize()
    const top = WORK_TITLEBAR_HEIGHT + WORK_BROWSER_TOOLBAR_HEIGHT
    const bounds = {
      x: WORK_BROWSER_INSET,
      y: top,
      width: Math.max(0, width - WORK_BROWSER_INSET * 2),
      height: Math.max(0, height - top - WORK_BROWSER_INSET)
    }
    for (const tab of this.tabs) tab.view.setBounds(bounds)
  }

  private setAllVisible(visible: boolean): void {
    for (const tab of this.tabs) tab.view.setVisible(visible)
  }

  private applyVisibility(): void {
    const windowReady =
      !this.overlayOpen &&
      !this.foldedHidden &&
      !this.win.isDestroyed() &&
      this.win.isVisible() &&
      !this.win.isMinimized()
    for (const tab of this.tabs) {
      tab.view.setVisible(windowReady && tab.id === this.activeId)
    }
  }

  private state(): WorkBrowserState {
    const active = this.tabs.find((tab) => tab.id === this.activeId)
    let canGoBack = false
    let canGoForward = false
    try {
      canGoBack = active?.view.webContents.navigationHistory.canGoBack() ?? false
      canGoForward = active?.view.webContents.navigationHistory.canGoForward() ?? false
    } catch {
      /* 页面已销毁 */
    }
    const tabs: WorkBrowserTab[] = this.tabs.map((tab) => ({
      id: tab.id,
      title: tab.title,
      url: tab.url,
      loading: tab.loading,
      error: tab.error
    }))
    return { tabs, activeId: this.activeId, canGoBack, canGoForward }
  }

  private emitState(): void {
    if (this.win.isDestroyed()) return
    try {
      this.win.webContents.send(IPC_WORK.BROWSER_STATE, this.state())
    } catch (err) {
      console.warn('[work-browser] 状态发送失败（忽略）：', err)
    }
  }
}
