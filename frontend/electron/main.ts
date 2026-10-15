/**
 * 主进程入口：生命周期、单例锁、窗口创建、系统托盘、调试快捷键、后端子进程接线。
 *
 * 职责边界：本文件不直接写平台特化代码——窗口创建与能力一律经 window/registry 解析平台实现（设计文档 §5.1）；
 * Python 子进程管理一律经 backend-process 域（设计文档 §5.2）；托盘一律经 tray 域。
 */
import { app, globalShortcut, type Tray } from 'electron'
import { join } from 'node:path'
import { resolveWindowImpl } from './window/registry'
import { registerIpcHandlers, pushDebugState, type IpcContext } from './ipc'
import { IPC_EVENTS } from './ipc/channels'
import { backendManager } from './backend-process'
import { createTray } from './tray'
import { runHideAnimation, runShowAnimation, destroyFx } from './fx'
import { runAnchorSelfTest } from './fx/anchor'
import { destroyTeaching, enterTeaching, initTeaching } from './teaching'
import type { PlatformWindow } from './window'

/** 宠物窗口尺寸（逻辑基准 400x400；渲染侧按 100vw/100vh 自适应） */
const PET_WINDOW_WIDTH = 400
const PET_WINDOW_HEIGHT = 400

/** 调试快捷键（避开常见组合，选用 F9–F11 + Ctrl+Shift） */
const SHORTCUTS = {
  toggleClickThrough: 'Control+Shift+F9',
  toggleAlwaysOnTop: 'Control+Shift+F10',
  toggleHitboxBorder: 'Control+Shift+F11',
  /** 调试栏（顶部状态 + 底部调试信息）显隐切换；渲染侧持有显隐状态，主进程只转发切换事件 */
  toggleDebugBar: 'Control+Shift+D'
} as const

const isDev = !app.isPackaged

let pet: PlatformWindow | null = null
let ipcCtx: IpcContext | null = null
/** 托盘实例（必须持有引用，否则会被 GC 回收导致图标消失，见 tray/index.ts 备忘） */
let tray: Tray | null = null
/** 调试态：hitbox 边框显示开关（主进程持有，渲染侧只渲染） */
let hitboxVisible = false

/** 创建宠物窗口并完成 IPC 注册 */
function createPetWindow(): PlatformWindow {
  const platformWindow = resolveWindowImpl()({
    width: PET_WINDOW_WIDTH,
    height: PET_WINDOW_HEIGHT,
    preload: join(__dirname, '../preload/preload.js')
  })
  const { window } = platformWindow

  // dev 态：把渲染进程 console 转发到主进程 stdout，便于无 devtools 环境验证/排障
  if (isDev) {
    window.webContents.on('console-message', (_event, _level, message) => {
      console.log(`[renderer] ${message}`)
    })
  }

  window.once('ready-to-show', () => {
    window.show()
    console.log('[main] 宠物窗口已显示')
  })
  window.on('closed', () => {
    pet = null
    ipcCtx = null
  })

  ipcCtx = {
    capability: platformWindow.capability,
    window,
    getHitboxVisible: () => hitboxVisible
  }
  registerIpcHandlers(ipcCtx)

  if (isDev && process.env['ELECTRON_RENDERER_URL']) {
    window.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    window.loadFile(join(__dirname, '../renderer/index.html'))
  }

  if (platformWindow.degraded) {
    console.warn('[main] 当前平台实现处于降级模式（部分能力不可用）')
  }
  return platformWindow
}

/** 注册调试快捷键（globalShortcut：穿透/失焦时窗口收不到按键，必须走全局） */
function registerDebugShortcuts(): void {
  const bind = (accelerator: string, handler: () => void): void => {
    if (globalShortcut.register(accelerator, handler)) {
      console.log(`[main] 调试快捷键已注册：${accelerator}`)
    } else {
      console.warn(`[main] 调试快捷键注册失败（可能被系统/其它程序占用）：${accelerator}`)
    }
  }

  bind(SHORTCUTS.toggleClickThrough, () => {
    if (!ipcCtx) return
    ipcCtx.capability.setClickThrough(!ipcCtx.capability.isClickThrough())
    pushDebugState(ipcCtx)
  })

  bind(SHORTCUTS.toggleAlwaysOnTop, () => {
    if (!ipcCtx) return
    ipcCtx.capability.setAlwaysOnTop(!ipcCtx.capability.isAlwaysOnTop())
    pushDebugState(ipcCtx)
  })

  bind(SHORTCUTS.toggleHitboxBorder, () => {
    if (!ipcCtx) return
    hitboxVisible = !hitboxVisible
    console.log(`[main] hitbox 边框 -> ${hitboxVisible ? '显示' : '隐藏'}`)
    pushDebugState(ipcCtx)
  })

  // 调试栏显隐：显隐状态由渲染侧持有（默认隐藏），主进程只转发"翻转"事件——
  // 保证穿透/失焦时（窗口收不到按键）仍可经全局快捷键唤起调试信息
  bind(SHORTCUTS.toggleDebugBar, () => {
    if (!ipcCtx) return
    console.log('[main] 调试栏显隐切换 → 通知渲染侧')
    ipcCtx.window.webContents.send(IPC_EVENTS.WINDOW_TOGGLE_DEBUG_BAR)
  })
}

// ---- 单例锁：桌宠只允许一个实例 ----
if (!app.requestSingleInstanceLock()) {
  console.log('[main] 已有实例在运行，本次启动退出')
  app.quit()
} else {
  app.on('second-instance', () => {
    // 二次启动 = 叫宠物出来（窗口已可见则什么都不做；隐藏中走显示动画）
    const w = pet?.window
    if (w && !w.isDestroyed() && !w.isVisible()) void runShowAnimation(w)
  })

  app.whenReady().then(() => {
    // dev/排障：托盘锚点定位自检（PET_ANCHOR_SELFTEST=1 → 抓屏定位；
    // =/path/shot.png → 对该截图跑模板匹配；不影响正常流程）
    const anchorSelfTest = process.env['PET_ANCHOR_SELFTEST']
    if (anchorSelfTest) void runAnchorSelfTest(anchorSelfTest)

    pet = createPetWindow()
    const petWin = pet.window
    // 关窗=躲进托盘（用户确认的行为）：Alt+F4 等关闭动作只隐藏窗口，且走魔法球捕获动画
    // （fx 域负责时序；动画异常/超时有兜底，结果语义"躲进托盘"一定生效）；
    // 真正退出走托盘菜单/系统退出（经 app.quit → before-quit 置 quitting=true 放行）
    petWin.on('close', (event) => {
      if (quitting) return
      event.preventDefault()
      console.log('[main] 关闭窗口 → 躲进托盘（退出请用托盘菜单）')
      void runHideAnimation(petWin)
    })
    // 系统托盘：常驻入口（显示/隐藏、教学模式、退出）；窗口显隐状态驱动其菜单文案
    tray = createTray(petWin)
    registerDebugShortcuts()
    // 教学模式（P5，设计文档 §7.5）编排中心：注册 IPC（托盘菜单/渲染面请求都进这里）；
    // 黑板窗口由它按需创建（进入教学模式前不存在）
    initTeaching(petWin)
    // 后端子进程与窗口并行启动（design §3.4）；就绪后经 IPC 下发 port/token
    backendManager.start()

    // dev/排障逃生门：PET_TEACHING_AUTOSTART=1 → ready 3s 后自动进入教学模式
    // （先例：PET_ANCHOR_SELFTEST；留给无 GUI 交互环境的自检路径）
    if (process.env['PET_TEACHING_AUTOSTART'] === '1') {
      console.log('[main] PET_TEACHING_AUTOSTART=1 → 3s 后自动进入教学模式（debug）')
      setTimeout(() => void enterTeaching('debug'), 3000)
    }
  })

  // 单窗口应用兜底：窗口被真关闭（仅退出流程中）后走应用退出；平时 close 已被"躲进托盘"拦截
  app.on('window-all-closed', () => {
    app.quit()
  })

  // 退出清理：先拦下退出，SIGTERM 后端子进程（3s 未退 SIGKILL），完成后真正退出（防僵尸）
  let backendCleanupStarted = false
  /** 真实退出流程已发起（任何 app.quit 都会先经过 before-quit）——窗口 close 不再拦截 */
  let quitting = false
  app.on('before-quit', (event) => {
    quitting = true
    if (backendCleanupStarted) return
    backendCleanupStarted = true
    event.preventDefault()
    console.log('[main] 应用退出：清理后端子进程…')
    backendManager
      .stop()
      .catch((err: unknown) => console.error('[main] 后端清理异常：', err))
      .finally(() => app.quit())
  })

  app.on('will-quit', () => {
    globalShortcut.unregisterAll()
    tray?.destroy()
    tray = null
    // 魔法球动画窗（若存在）随退出直接销毁——退出链路不播动画、不做等待
    destroyFx()
    // 黑板窗口（若存在）同样直接销毁（教学模式编排中心复位为 normal）
    destroyTeaching()
  })
}
