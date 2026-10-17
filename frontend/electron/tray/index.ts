/**
 * 系统托盘域（设计文档 §1.1：托盘/全局快捷键/单例锁属主进程职责）。
 *
 * 职责：在系统托盘区（DDE 右下角小图标区）提供常驻入口——
 *  - **自绘菜单窗**（§7.6.4 v2，主题跟随）：无边框透明置顶小窗加载 tray-menu.html，
 *    定位托盘图标锚点旁、失焦自动收起；菜单项动作经 IPC.TRAY_MENU_ACTION 回流本域执行
 *    （显示/隐藏宠物、教学模式、设置、退出 = 原原生菜单四件套）；
 *  - 原生菜单：仅 Linux 保留作右键兜底（见下方实测结论）；
 *  - 单击=叫它出来（显示宠物，魔法球动画）；Linux **双击**=弹出自绘菜单（替代入口）。
 *
 * 平台差异（2026-10-15 实测：Deepin DDE + X11，Electron 33.4.11；探测方法/证据见报告）：
 *  - **DDE 下右键事件不可用**：右键由 DDE 直接与托盘项的 DBusMenu 交互（dbus-monitor 实测：
 *    ButtonPress → com.canonical.dbusmenu AboutToShow/GetLayout/Event，全在 DBus 层），
 *    Electron JS 层收不到任何鼠标事件——`right-click` 官方文档亦仅标注 darwin/win32；
 *    中键不派发任何事件；双击只派发**两次 click**（无 double-click 事件）。
 *    → Linux 降级：保留原生菜单（右键兜底，样式系统渲染）+ 双击自绘菜单（主题化入口）；
 *      单击语义保持不变（第一击立即"叫它出来"、零延迟；第二击 <400ms 弹菜单）。
 *    → Win/macOS：不设原生菜单，right-click → 自绘菜单。
 *  - 单击（左键 Activate）派发 click 事件（实测 triggeredByAccelerator=true），本环境完全可用。
 *
 * 图标加载（dev/生产双路径，模式同 backend-process/locate.ts）：
 *  - 开发态：frontend/build/icon.png 优先（设计素材的单一来源，素材更新即时生效），
 *    回退 frontend/resources/tray-icon.png；
 *  - 生产态：process.resourcesPath/tray-icon.png —— electron-builder 把
 *    frontend/resources/tray-icon.png 经 extraResources 拷到 resources/ 根下
 *    （build/ 是构建元数据目录、默认不进安装包，绝不能在生产态引用它）。
 *
 * 备忘：Tray 实例必须被长期持有（main.ts 里保存引用），否则会被 GC 回收导致图标消失；
 * 菜单窗懒创建（hide 而非 destroy，之后复用——页面常驻、主题即时跟随），退出时 destroy。
 */
import {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  screen,
  Tray,
  nativeImage,
  type MenuItemConstructorOptions,
  type WebContents
} from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { isLinux, isWindows, linuxOnlyWindowOptions } from '../platform'
import { IPC, IPC_EVENTS, type TrayMenuAction } from '../ipc/channels'
import { runHideAnimation, runShowAnimation, setTrayAnchorProvider } from '../ball-animation'
import { enterTeaching } from '../teaching'
import { openSettings } from '../settings'

const isDev = !app.isPackaged

/**
 * 托盘图标基准边长（px）。Linux 托盘区常见高度 22~24px，22 是 Electron 官方建议值；
 * 高 DPR（2x）下按 scaleFactor 放大到最多 44px，避免 HiDPI 屏上发糊。
 */
const TRAY_ICON_BASE_SIZE = 22
/** 图标放大上限（2x）：超过 2 倍的 DPR 也用 44px，避免图过大撑破托盘格 */
const TRAY_ICON_MAX_SCALE = 2

/**
 * 自绘菜单窗尺寸（px）：与 tray-menu.css 的内容约定一致——
 * 4 项 × 34 行高 + 1 分隔 + 2px 组间距 + 6px 内边距 + 边框 ≈ 163px（宽 180）；
 * 内容在窗口内垂直居中（CSS justify-content:center），略富余无碍。
 */
const TRAY_MENU_WIDTH = 180
const TRAY_MENU_HEIGHT = 164
/** 菜单与托盘图标（/鼠标点）之间的纵向间隙（px） */
const TRAY_MENU_GAP = 8
/** 菜单与工作区边缘的最小边距（px） */
const TRAY_MENU_MARGIN = 4
/** Linux 双击判定窗口（ms）：实测 DDE 只派发两次 click（无 double-click），主进程自判 */
const DOUBLE_CLICK_MS = 400
/** 首次弹出等待菜单页加载完成的超时（ms） */
const MENU_READY_TIMEOUT_MS = 2500
/** show 后的初始化载荷补发延迟（ms）：did-finish-load 早于 React 首帧/订阅建立的兜底（幂等） */
const MENU_INIT_REPOST_MS = 150

// ------------------------------------------------------------------ 模块级状态（本域单例）

/** 菜单窗（懒创建；hide 而非 destroy，之后复用） */
let trayMenuWin: BrowserWindow | null = null
/** 菜单页已加载完成标志（did-finish-load 置位；窗口重建后复位） */
let menuReady = false
/** 等待就绪的回调队列（菜单页加载完成时统一唤醒） */
let menuReadyWaiters: Array<() => void> = []
/** 弹出进行中（定位是异步的：防双击/动作等竞态重入） */
let menuOpening = false
/** 上次托盘 click 时间戳（Linux 双击判定） */
let lastClickAt = 0
/** ipcMain 监听是否已注册（只能注册一次，重复注册会叠加处理器） */
let ipcRegistered = false
/** 宠物窗口（createTray 注入；菜单动作/显隐切换的对象） */
let petWin: BrowserWindow | null = null
/**
 * 读取托盘图标矩形（createTray 注入；Win/macOS 有原生实现，Linux 会抛/返回空）。
 * 用于菜单定位与动画锚点——**替代抓屏模板匹配**：Windows 175% 缩放下抓屏实测 2124ms
 * 且模板匹配不上，右键托盘/隐藏宠物每次都要等 2 秒，是"卡"的根因。
 */
let readTrayBounds: (() => Electron.Rectangle | null) | null = null

// ------------------------------------------------------------------ 图标

/** 解析托盘图标绝对路径；两态都不存在时返回 null（托盘降级为无图标，不阻塞启动） */
function resolveTrayIconPath(): string | null {
  if (!app.isPackaged) {
    // 开发态：electron-vite dev 下 app.getAppPath() = frontend/
    // 素材唯一源：build/icon.png（打包侧 extraResources 也从这里取，见 electron-builder.yml）
    const devIcon = join(app.getAppPath(), 'build', 'icon.png')
    return existsSync(devIcon) ? devIcon : null
  }
  const packaged = join(process.resourcesPath, 'tray-icon.png')
  return existsSync(packaged) ? packaged : null
}

/** 按 DPR 载入并缩放托盘图标（找不到文件时返回 empty image，由调用方降级） */
function loadTrayImage(): Electron.NativeImage {
  const iconPath = resolveTrayIconPath()
  if (!iconPath) {
    console.warn('[tray] 未找到托盘图标（build/icon.png 不存在）')
    return nativeImage.createEmpty()
  }
  const image = nativeImage.createFromPath(iconPath)
  if (image.isEmpty()) {
    console.warn(`[tray] 托盘图标加载失败（空图）：${iconPath}`)
    return image
  }
  const scale = Math.min(Math.max(screen.getPrimaryDisplay().scaleFactor, 1), TRAY_ICON_MAX_SCALE)
  const size = Math.round(TRAY_ICON_BASE_SIZE * scale)
  console.log(`[tray] 图标：${iconPath}（${image.getSize().width}px → ${size}px, scale=${scale}）`)
  return image.resize({ width: size, height: size, quality: 'best' })
}

// ------------------------------------------------------------------ 自绘菜单窗

/**
 * 加载菜单页：dev 走 electron-vite 渲染服务器（ELECTRON_RENDERER_URL，同目录 tray-menu.html）；
 * 生产走打包产物 out/renderer/tray-menu.html（与 board/settings 同法）。
 */
function loadTrayMenuPage(win: BrowserWindow): void {
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (isDev && devUrl) {
    // 用 URL 相对解析：base 无论是否带尾斜杠/是否带 index.html，都能得到同目录的 tray-menu.html
    try {
      void win.loadURL(new URL('tray-menu.html', devUrl).toString())
      return
    } catch (err) {
      console.warn(`[tray] ELECTRON_RENDERER_URL 非法（${devUrl}），回退 loadFile：`, err)
    }
  }
  void win.loadFile(join(__dirname, '../renderer/tray-menu.html'))
}

/** 创建菜单窗（窗口技术照 fx 球窗/黑板窗先例：transparent + frame:false + alwaysOnTop + skipTaskbar；Linux type:'toolbar'） */
function createTrayMenuWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: TRAY_MENU_WIDTH,
    height: TRAY_MENU_HEIGHT,
    transparent: true,
    backgroundColor: '#00000000',
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    hasShadow: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    // DDE(Dock) 忽略 skipTaskbar——沿用宠物窗实测结论：type:'toolbar' 可让 Dock 不出现窗口格
    // （选项按平台从 electron/platform 取，非 Linux 为空对象）
    ...linuxOnlyWindowOptions(),
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  // 层级抬到最高（同球窗）：菜单出现时应盖在宠物窗/设置窗之上
  win.setAlwaysOnTop(true, 'screen-saver')

  // dev 态：菜单页 console 转发到主进程 stdout（排障；同宠物窗）
  if (isDev) {
    win.webContents.on('console-message', (_event, _level, message) => {
      console.log(`[tray-menu-renderer] ${message}`)
    })
  }

  // did-finish-load = 页面骨架就绪（React 订阅通常紧随其后；仍由 MENU_INIT_REPOST_MS 补发兜底）
  win.webContents.on('did-finish-load', () => {
    menuReady = true
    const waiters = menuReadyWaiters
    menuReadyWaiters = []
    waiters.forEach((fn) => fn())
  })

  // 失焦自动收起（点菜单外任意处/切换窗口 → 菜单消失，防残留）
  win.on('blur', () => {
    if (!win.isDestroyed() && win.isVisible()) hideTrayMenu('blur')
  })

  win.on('closed', () => {
    if (trayMenuWin === win) {
      trayMenuWin = null
      menuReady = false
    }
  })

  // 加载失败/渲染崩溃兜底：销毁窗口清引用（下次弹出重建重试；与 settings 域同法）
  win.webContents.on(
    'did-fail-load',
    (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrame || trayMenuWin !== win) return
      console.error(
        `[tray] 菜单页加载失败（${errorCode} ${errorDescription} ${validatedURL}），销毁窗口以便重试`
      )
      trayMenuWin = null
      menuReady = false
      if (!win.isDestroyed()) win.destroy()
    }
  )
  win.webContents.on('render-process-gone', (_event, details) => {
    if (trayMenuWin !== win) return
    console.error(`[tray] 菜单页渲染进程崩溃（${details.reason}），销毁窗口以便重试`)
    trayMenuWin = null
    menuReady = false
    if (!win.isDestroyed()) win.destroy()
  })

  loadTrayMenuPage(win)
  console.log(`[tray] 自绘菜单窗已创建（${TRAY_MENU_WIDTH}x${TRAY_MENU_HEIGHT}）`)
  return win
}

/** 取（必要时创建）菜单窗 */
function ensureTrayMenuWindow(): BrowserWindow {
  if (trayMenuWin && !trayMenuWin.isDestroyed()) return trayMenuWin
  menuReady = false
  trayMenuWin = createTrayMenuWindow()
  return trayMenuWin
}

/** 等待菜单页加载完成（带超时；照 ball-animation 域 waitFxReady 模式） */
function waitMenuReady(timeoutMs: number): Promise<boolean> {
  if (menuReady) return Promise.resolve(true)
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      menuReadyWaiters = menuReadyWaiters.filter((fn) => fn !== onReady)
      resolve(false)
    }, timeoutMs)
    const onReady = (): void => {
      clearTimeout(timer)
      resolve(true)
    }
    menuReadyWaiters.push(onReady)
  })
}

/**
 * 菜单弹出位置：优先托盘图标 bounds（Win/macOS 原生 API，零延迟），拿不到就用当前鼠标位置
 * （右键/双击托盘时鼠标就在图标上）——**不再抓屏模板匹配**（Windows 实测 2124ms，菜单会明显卡住）。
 * 一律 clamp 进所在显示器工作区。
 */
function resolveMenuPosition(): { x: number; y: number } {
  const b = readTrayBounds?.() ?? null
  let cx: number
  let cy: number
  if (b) {
    cx = b.x + b.width / 2
    cy = b.y + b.height / 2
  } else {
    const p = screen.getCursorScreenPoint()
    cx = p.x
    cy = p.y
    console.log(`[tray] 托盘 bounds 不可用 → 菜单锚点用鼠标位置 (${cx},${cy})`)
  }
  const wa = screen.getDisplayNearestPoint({ x: cx, y: cy }).workArea
  const x = cx - Math.round(TRAY_MENU_WIDTH / 2)
  const y = cy - TRAY_MENU_HEIGHT - TRAY_MENU_GAP
  const minX = wa.x + TRAY_MENU_MARGIN
  const maxX = wa.x + wa.width - TRAY_MENU_WIDTH - TRAY_MENU_MARGIN
  const minY = wa.y + TRAY_MENU_MARGIN
  const maxY = wa.y + wa.height - TRAY_MENU_HEIGHT - TRAY_MENU_MARGIN
  return {
    x: Math.min(Math.max(x, minX), Math.max(minX, maxX)),
    y: Math.min(Math.max(y, minY), Math.max(minY, maxY))
  }
}

/** 收起菜单窗（blur / 执行动作 / 退出前；未弹出时 no-op） */
function hideTrayMenu(reason: string): void {
  const menu = trayMenuWin
  if (!menu || menu.isDestroyed() || !menu.isVisible()) return
  menu.hide()
  console.log(`[tray] 自绘菜单收起（${reason}）`)
}

/**
 * 弹出自绘菜单（Linux 双击第二击 / Win·macOS right-click）。
 * 幂等：正在弹出（异步定位中）时忽略重复请求；已可见时视为"刷新"（重发文案/重定位，
 * 收起走失焦/动作/再点）。
 */
async function openTrayMenu(): Promise<void> {
  if (menuOpening) return
  menuOpening = true
  try {
    const menu = ensureTrayMenuWindow()
    if (!menuReady && !(await waitMenuReady(MENU_READY_TIMEOUT_MS))) {
      console.warn(`[tray] 菜单页 ${MENU_READY_TIMEOUT_MS}ms 未就绪，本次取消弹出`)
      return
    }
    if (menu.isDestroyed()) return
    const pos = resolveMenuPosition()
    if (menu.isDestroyed()) return

    const petVisible = Boolean(petWin && !petWin.isDestroyed() && petWin.isVisible())
    const sendInit = (): void => {
      if (!menu.isDestroyed() && !menu.webContents.isDestroyed()) {
        menu.webContents.send(IPC_EVENTS.TRAY_MENU_INIT, { petVisible })
      }
    }
    // 弹出前下发初始化载荷（文案驱动）；did-finish-load 早于 React 订阅建立时首帧可能丢失，
    // show 后延迟补发一次（幂等，页面只是 setState 相同值）
    sendInit()
    menu.setBounds({ x: pos.x, y: pos.y, width: TRAY_MENU_WIDTH, height: TRAY_MENU_HEIGHT })
    menu.show()
    menu.focus()
    setTimeout(sendInit, MENU_INIT_REPOST_MS)
    console.log(`[tray] 自绘菜单已弹出 @ ${pos.x},${pos.y}（petVisible=${petVisible}）`)
  } catch (err) {
    console.error('[tray] 弹出自绘菜单异常：', err)
  } finally {
    menuOpening = false
  }
}

/** sender 是否当前受管菜单窗（"菜单窗专属"消息只认它） */
function isMenuSender(sender: WebContents): boolean {
  return Boolean(
    trayMenuWin && !trayMenuWin.isDestroyed() && sender.id === trayMenuWin.webContents.id
  )
}

/** 菜单项动作白名单校验（渲染面误发/脏数据一律忽略） */
const TRAY_MENU_ACTIONS: readonly TrayMenuAction[] = ['toggle-pet', 'teaching', 'settings', 'quit']
function normalizeMenuAction(a: unknown): TrayMenuAction | null {
  return typeof a === 'string' && (TRAY_MENU_ACTIONS as readonly string[]).includes(a)
    ? (a as TrayMenuAction)
    : null
}

/** 应用退出清理（will-quit；菜单窗直接销毁，不做额外等待） */
export function destroyTrayMenu(): void {
  const menu = trayMenuWin
  trayMenuWin = null
  menuReady = false
  menuReadyWaiters = []
  if (menu && !menu.isDestroyed()) menu.destroy()
}

// ------------------------------------------------------------------ 托盘本体

/**
 * 创建系统托盘（须在 app ready 后调用）。
 * @param win 宠物窗口（菜单/单击对它做 show/hide）
 * @returns Tray 实例；创建失败返回 null（不阻塞应用启动）。调用方必须持有引用。
 */
export function createTray(win: BrowserWindow): Tray | null {
  petWin = win

  let tray: Tray
  try {
    tray = new Tray(loadTrayImage())
  } catch (err) {
    console.error('[tray] 托盘创建失败：', err)
    return null
  }

  tray.setToolTip('AI 桌面宠物')

  // 托盘图标矩形（Win/macOS 原生；Linux 调用会抛/返回空）——菜单定位与动画锚点共用。
  // 零延迟，替代抓屏模板匹配（Windows 实测 2124ms + 模板未命中）。
  readTrayBounds = (): Electron.Rectangle | null => {
    try {
      const b = tray.getBounds()
      return b && b.width > 0 && b.height > 0 ? b : null
    } catch {
      return null
    }
  }

  // 动画锚点提供者：有 bounds 用图标中心；Win 的 overflow 里 getBounds 可能返回 0×0，
  // 此时用任务栏右下角兜底（图标就在那一片），绝不能让动画再走 2 秒抓屏；
  // Linux/macOS 返回 null → 保留各自既有的抓屏模板匹配路径。
  setTrayAnchorProvider(() => {
    const b = readTrayBounds?.() ?? null
    if (b) {
      const p = { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) }
      console.log(`[tray] 动画锚点：图标 bounds → (${p.x},${p.y})`)
      return p
    }
    if (!isWindows) return null
    const wa = screen.getPrimaryDisplay().workArea
    const p = { x: wa.x + wa.width - 90, y: wa.y + wa.height - 24 }
    console.log(`[tray] 动画锚点：bounds 不可用 → 任务栏右下角兜底 (${p.x},${p.y})`)
    return p
  })

  /**
   * 切换宠物窗口显隐（走 ball-animation 域魔法球动画；结果语义不变：可见→隐藏、不可见→显示）。
   * 动画期间重复触发由 ball-animation 域的锁忽略；动画异常/超时有兜底，hide/show 一定生效。
   */
  const toggleVisibility = (): void => {
    const w = petWin
    if (!w || w.isDestroyed()) return
    if (w.isVisible()) {
      console.log('[tray] 隐藏宠物窗口（魔法球动画）')
      void runHideAnimation(w)
    } else {
      console.log('[tray] 显示宠物窗口（魔法球动画）')
      void runShowAnimation(w)
    }
  }

  /** 构建原生菜单模板：文案随窗口显隐态更新（可见 → "隐藏宠物"，不可见 → "显示宠物"） */
  const buildTemplate = (): MenuItemConstructorOptions[] => [
    {
      label: win.isVisible() ? '隐藏宠物' : '显示宠物',
      click: toggleVisibility
    },
    { type: 'separator' },
    {
      label: '教学模式',
      // 进入教学模式（P5，§7.5）：黑板滑入 + 宠物走讲台位；退出走宠物面关键词或黑板 ×
      click: () => {
        console.log('[tray] 菜单：进入教学模式（reason=menu）')
        void enterTeaching('menu')
      }
    },
    {
      label: '设置',
      // 打开独立设置窗口（P4 前置，§7.6.1）：单例——已打开则聚焦（窗口生命周期归 settings 域）
      click: () => {
        console.log('[tray] 菜单：打开设置窗口')
        openSettings()
      }
    },
    { type: 'separator' },
    {
      label: '退出',
      // 走既有退出清理链路：app.quit → before-quit 拦截 → backendManager.stop() → 真正退出
      click: () => app.quit()
    }
  ]

  // ---- 原生菜单：仅 Linux 保留（DDE 右键直接走 DBusMenu，Electron 收不到 right-click，
  //      自绘菜单无法用右键触发 → 原生菜单作右键兜底；Win/macOS 走 right-click → 自绘）----
  if (isLinux) {
    const refreshMenu = (): void => {
      tray.setContextMenu(Menu.buildFromTemplate(buildTemplate()))
    }
    refreshMenu()
    // 窗口显隐（含渲染侧拖拽/快捷键等间接引起的显隐）后刷新菜单文案
    win.on('show', refreshMenu)
    win.on('hide', refreshMenu)
  }

  // ---- 自绘菜单动作（菜单窗 → 主；执行后收起菜单窗）----
  if (!ipcRegistered) {
    ipcRegistered = true
    ipcMain.on(IPC.TRAY_MENU_ACTION, (event, action: unknown) => {
      if (!isMenuSender(event.sender)) return
      const a = normalizeMenuAction(action)
      if (!a) return
      console.log(`[tray] 自绘菜单动作：${a}`)
      // 先收起菜单再执行：动作会弹设置窗/播魔法球动画/进教学模式——菜单立即消失观感最顺
      hideTrayMenu('action')
      switch (a) {
        case 'toggle-pet':
          toggleVisibility()
          break
        case 'teaching':
          void enterTeaching('menu')
          break
        case 'settings':
          openSettings()
          break
        case 'quit':
          app.quit()
          break
      }
    })
    console.log('[tray] 自绘菜单 IPC 处理器已注册')
  }

  // 单击=叫它出来（仅显示，不切换）：修复"单击与菜单双路径叠加、两次 toggle 互相抵消"的
  // 静默失效（DDE 下单击/菜单事件来源不可控，成对触发导致看起来没反应）。
  // 隐藏走菜单"隐藏宠物"或 Alt+F4；菜单项仍为 toggle（动态文案，语义清晰）。
  // Linux 追加双击判定（实测 DDE 无 double-click 事件，只派发两次 click）：
  // 第一击语义不变（立即"叫它出来"、零延迟）；第二击（<400ms）改为弹自绘菜单。
  tray.on('click', () => {
    const w = petWin
    if (!w || w.isDestroyed()) return
    if (isLinux) {
      const now = Date.now()
      if (now - lastClickAt < DOUBLE_CLICK_MS) {
        lastClickAt = 0
        console.log('[tray] 双击托盘 → 弹出自绘菜单（Linux 降级替代入口）')
        void openTrayMenu()
        return
      }
      lastClickAt = now
    }
    if (w.isVisible()) return
    console.log('[tray] 单击托盘 → 显示宠物窗口（魔法球动画）')
    void runShowAnimation(w)
  })

  // Win/macOS：right-click 可用 → 右键弹自绘菜单（无原生菜单）
  if (!isLinux) {
    tray.on('right-click', () => {
      console.log('[tray] 右键托盘 → 弹出自绘菜单')
      void openTrayMenu()
    })
  }

  console.log('[tray] 托盘已创建（自绘菜单：显示/隐藏宠物、教学模式、设置、退出；单击=叫它出来）')
  return tray
}
