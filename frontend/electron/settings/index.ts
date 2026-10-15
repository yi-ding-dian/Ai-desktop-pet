/**
 * 设置窗口域（P4 前置，设计文档 §7.6）——独立设置窗口的生命周期 + 应用级 IPC。
 *
 * 职责边界（高内聚：与设置窗口有关的一切都在本目录）：
 *  - 窗口生命周期：单例（已打开 → 聚焦；关闭即清引用，下次打开重建）、约 640×560 居中、
 *    **系统标题栏常规窗口**（frame:true、可拖动/最小化、任务栏可见）——设置是工具型界面，
 *    用户预期是正常窗口；刻意**不**照抄宠物窗/黑板窗的「无边框 + 透明 + 置顶 + skipTaskbar +
 *    Linux type:'toolbar'」悬浮窗技术（那是给「不该出现在任务栏的桌宠层」用的）；
 *  - 页面加载：settings.html（dev 走 ELECTRON_RENDERER_URL 同目录换名、生产 out/renderer/settings.html，
 *    与 teaching 的 board.html 同法）；
 *  - IPC 契约（channels.ts 已写死）：
 *      IPC.SETTINGS_OPEN —— 托盘菜单 / 聊天关键词共用入口 → openSettings()（单例收敛）；
 *      IPC.APP_RESTART   —— 设置页「重启」→ restartApp()：先停后端（防孤儿进程）再 relaunch。
 *
 * 数据流（§7.6.2）：设置页**自持 WS 连接**（经 backend.getSnapshot() 取 port/token 自行连接），
 * 本域不参与设置项读写——只管「窗口怎么开、怎么关、重启怎么做」。
 */
import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { join } from 'node:path'
import { IPC } from '../ipc/channels'
import { backendManager } from '../backend-process'

const isDev = !app.isPackaged

/** 设置窗口尺寸（逻辑像素；§7.6.1「约 640×560 居中打开」） */
const SETTINGS_WINDOW_WIDTH = 640
const SETTINGS_WINDOW_HEIGHT = 560
/** 窗口标题（主进程为权威：page-title-updated 被拦截，防渲染页 <title> 覆盖契约文案） */
const SETTINGS_WINDOW_TITLE = '设置 · AI 桌面宠物'

// ------------------------------------------------------------------ 模块级状态（本域单例）

/** 当前设置窗口（单例；关闭/加载失败后置 null，下次打开重建） */
let settingsWin: BrowserWindow | null = null
/** ipcMain 监听是否已注册（只能注册一次，重复注册会叠加处理器） */
let ipcRegistered = false
/** 重启流程进行中标志（防「重启」按钮连点触发两次 stop + relaunch） */
let restarting = false

// ------------------------------------------------------------------ 窗口生命周期

/**
 * 创建设置窗口（常规窗口技术，见文件头；窗口本身不在创建时显示——
 * ready-to-show 后 show，防白屏闪烁，同宠物窗）。
 */
function createSettingsWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: SETTINGS_WINDOW_WIDTH,
    height: SETTINGS_WINDOW_HEIGHT,
    title: SETTINGS_WINDOW_TITLE,
    // 系统标题栏常规窗口：frame:true（默认）显式写出，强调与宠物/黑板的刻意不同；
    // 不设 alwaysOnTop / skipTaskbar / type:'toolbar'——任务栏可见、可最小化、可拖动
    frame: true,
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  // 标题权威在主进程：渲染页对 document.title 的更新一律丢弃（契约固定「设置 · AI 桌面宠物」）
  win.on('page-title-updated', (event) => event.preventDefault())

  // 常规窗口默认会显示 Electron 应用菜单栏（File/Edit/View…）——工具型设置页不需要，去掉
  win.setMenu(null)

  // 外链走系统浏览器（设置页「去获取 Key」等 http(s) 链接）；其余新窗口一律拒绝
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://') || url.startsWith('http://')) void shell.openExternal(url)
    return { action: 'deny' }
  })

  // dev 态：渲染进程 console 转发到主进程 stdout（无 devtools 环境排障；同宠物窗/黑板窗）
  if (isDev) {
    win.webContents.on('console-message', (_event, _level, message) => {
      console.log(`[settings-renderer] ${message}`)
    })
  }

  win.once('ready-to-show', () => {
    win.show()
    console.log('[settings] 设置窗口已显示')
  })

  win.on('closed', () => {
    if (settingsWin === win) settingsWin = null
    console.log('[settings] 设置窗口已关闭（引用已清理，下次打开重建）')
  })

  // 加载失败/渲染崩溃兜底：关闭窗口并清引用（单例不卡在坏窗口上，用户下次点击即重建重试）。
  // 只看「当前受管窗口」（settingsWin === win）：旧窗口迟来事件不再处理（同 teaching 受管窗口约定）
  win.webContents.on(
    'did-fail-load',
    (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrame || settingsWin !== win) return
      console.error(
        `[settings] 设置页加载失败（${errorCode} ${errorDescription} ${validatedURL}），关闭窗口以便重试`
      )
      settingsWin = null
      if (!win.isDestroyed()) win.destroy()
    }
  )

  win.webContents.on('render-process-gone', (_event, details) => {
    if (settingsWin !== win) return
    console.error(`[settings] 设置页渲染进程崩溃（${details.reason}），关闭窗口以便重试`)
    settingsWin = null
    if (!win.isDestroyed()) win.destroy()
  })

  loadSettingsPage(win)
  // 居中打开（主显示器工作区中央；§7.6.1）
  win.center()
  console.log(
    `[settings] 设置窗口已创建（${SETTINGS_WINDOW_WIDTH}x${SETTINGS_WINDOW_HEIGHT} 居中；${win.getBounds().x},${win.getBounds().y}）`
  )
  return win
}

/**
 * 加载设置页：dev 走 electron-vite 渲染服务器（ELECTRON_RENDERER_URL，文件名换成 settings.html）；
 * 生产走打包产物 out/renderer/settings.html。settings.html 由渲染侧提供，本域只管路径约定。
 */
function loadSettingsPage(win: BrowserWindow): void {
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (isDev && devUrl) {
    // 用 URL 相对解析：base 无论是否带尾斜杠/是否带 index.html，都能得到同目录的 settings.html
    // （与 teaching/board.html 同法）
    try {
      void win.loadURL(new URL('settings.html', devUrl).toString())
      return
    } catch (err) {
      console.warn(`[settings] ELECTRON_RENDERER_URL 非法（${devUrl}），回退 loadFile：`, err)
    }
  }
  void win.loadFile(join(__dirname, '../renderer/settings.html'))
}

/**
 * 打开设置窗口（唯一公共入口：托盘菜单 / SETTINGS_OPEN IPC 都走这里）。
 * 单例：已打开则聚焦（最小化先还原），不重复创建。
 */
export function openSettings(): void {
  const existing = settingsWin
  if (existing && !existing.isDestroyed()) {
    if (existing.isMinimized()) existing.restore()
    // show() 对已可见窗口仍是「显示并聚焦」，兼顾「存在但被隐藏」的极端态
    existing.show()
    existing.focus()
    console.log('[settings] 设置窗口已存在 → 聚焦（不重复创建）')
    return
  }
  settingsWin = createSettingsWindow()
}

/** 应用退出清理（will-quit；窗口随退出直接销毁，不做额外等待） */
export function destroySettings(): void {
  const win = settingsWin
  settingsWin = null
  if (win && !win.isDestroyed()) win.destroy()
}

// ------------------------------------------------------------------ 应用重启

/**
 * 重启应用（IPC.APP_RESTART → 设置页「重启」按钮，§7.6.3「无法热更的项提供重启入口」）。
 *
 * **不能用裸 app.exit**：app.exit 跳过 before-quit 的退出清理链，会留下孤儿 Python 后端进程。
 * 因此这里主动走一遍后端清理（backendManager.stop()：SIGTERM → 3s 宽限 → SIGKILL，与
 * main.ts 退出链路同一条），完成后再 app.relaunch() + app.exit(0) 强制退出
 * （exit 不触发 before-quit/will-quit——清理已先行做完，无需再走一遍）。
 */
async function restartApp(): Promise<void> {
  if (restarting) {
    console.log('[settings] 重启流程进行中，忽略重复请求')
    return
  }
  restarting = true
  console.log('[settings] 收到重启请求：先停后端子进程（防孤儿进程），再 relaunch')
  try {
    await backendManager.stop()
  } catch (err) {
    // 清理异常不阻塞重启（stop 内部有超时兜底；孤儿进程风险由 SIGKILL 兜底覆盖）
    console.error('[settings] 重启前后端清理异常（继续重启）：', err)
  }
  // 顺序固定：先登记 relaunch（以当前 argv/execPath 重启），再强制退出
  app.relaunch()
  app.exit(0)
}

// ------------------------------------------------------------------ IPC 接线（渲染 → 主）

/** 注册设置域 IPC 处理器（main.ts 在 app ready 后调用一次；无窗口依赖，无需传参） */
export function initSettings(): void {
  if (ipcRegistered) return
  ipcRegistered = true

  // 打开设置：托盘菜单与渲染侧（宠物面关键词「打开设置」）共用入口。
  // 无 sender 过滤：「打开设置」是无害幂等操作（重复打开收敛为聚焦），任何渲染面触发都安全
  ipcMain.on(IPC.SETTINGS_OPEN, () => {
    openSettings()
  })

  // 重启应用（设置页「重启」按钮）：先走后端退出清理链再 relaunch，防孤儿后端进程
  ipcMain.on(IPC.APP_RESTART, () => {
    void restartApp()
  })

  console.log('[settings] IPC 处理器已注册')
}
