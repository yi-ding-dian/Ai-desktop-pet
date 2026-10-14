/**
 * 主进程入口：生命周期、单例锁、窗口创建、调试快捷键。
 *
 * 职责边界：本文件不直接写平台特化代码——窗口创建与能力一律经 window/registry 解析平台实现（设计文档 §5.1）。
 */
import { app, globalShortcut } from 'electron'
import { join } from 'node:path'
import { resolveWindowImpl } from './window/registry'
import { registerIpcHandlers, pushDebugState, type IpcContext } from './ipc'
import type { PlatformWindow } from './window'

/** 宠物窗口尺寸（逻辑基准 400x400；渲染侧按 100vw/100vh 自适应） */
const PET_WINDOW_WIDTH = 400
const PET_WINDOW_HEIGHT = 400

/** 调试快捷键（避开常见组合，选用 F9–F11 + Ctrl+Shift） */
const SHORTCUTS = {
  toggleClickThrough: 'Control+Shift+F9',
  toggleAlwaysOnTop: 'Control+Shift+F10',
  toggleHitboxBorder: 'Control+Shift+F11'
} as const

const isDev = !app.isPackaged

let pet: PlatformWindow | null = null
let ipcCtx: IpcContext | null = null
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
}

// ---- 单例锁：桌宠只允许一个实例 ----
if (!app.requestSingleInstanceLock()) {
  console.log('[main] 已有实例在运行，本次启动退出')
  app.quit()
} else {
  app.on('second-instance', () => {
    pet?.window.show()
  })

  app.whenReady().then(() => {
    pet = createPetWindow()
    registerDebugShortcuts()
  })

  // 桌宠为单窗口应用：窗口关闭即退出（Linux/Windows 惯例）
  app.on('window-all-closed', () => {
    app.quit()
  })

  app.on('will-quit', () => {
    globalShortcut.unregisterAll()
  })
}
