/**
 * 系统托盘域（设计文档 §1.1：托盘/全局快捷键/单例锁属主进程职责）。
 *
 * 职责：在系统托盘区（DDE 右下角小图标区）提供常驻入口——
 *  - 菜单：显示/隐藏宠物（win.show/hide 切换）、退出（app.quit → 既有 before-quit 清理链路）；
 *  - 单击切换显隐（尽力而为：Linux 走 StatusNotifierItem，宿主行为有差异，见下方注释）。
 *
 * 图标加载（dev/生产双路径，模式同 backend-process/locate.ts）：
 *  - 开发态：frontend/build/icon.png 优先（设计素材的单一来源，素材更新即时生效），
 *    回退 frontend/resources/tray-icon.png；
 *  - 生产态：process.resourcesPath/tray-icon.png —— electron-builder 把
 *    frontend/resources/tray-icon.png 经 extraResources 拷到 resources/ 根下
 *    （build/ 是构建元数据目录、默认不进安装包，绝不能在生产态引用它）。
 *
 * 平台差异备忘（2026-10-15 实测/查证）：
 *  - Linux（DDE）：Tray 经 SNI（DBus StatusNotifierItem）注册，DDE 托盘区显示小图标；
 *    对左键单击是否派发 click 事件，各宿主实现不一（部分宿主左键直接弹 DBus 菜单、
 *    click 事件不触发）——菜单里的"显示/隐藏宠物"是保底入口，单击切换属尽力行为。
 *  - Tray 实例必须被长期持有（main.ts 里保存引用），否则会被 GC 回收导致图标消失。
 */
import { app, Menu, Tray, nativeImage, screen, type BrowserWindow, type MenuItemConstructorOptions } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { runHideAnimation, runShowAnimation } from '../fx'
import { enterTeaching } from '../teaching'

/**
 * 托盘图标基准边长（px）。Linux 托盘区常见高度 22~24px，22 是 Electron 官方建议值；
 * 高 DPR（2x）下按 scaleFactor 放大到最多 44px，避免 HiDPI 屏上发糊。
 */
const TRAY_ICON_BASE_SIZE = 22
/** 图标放大上限（2x）：超过 2 倍的 DPR 也用 44px，避免图过大撑破托盘格 */
const TRAY_ICON_MAX_SCALE = 2

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

/**
 * 创建系统托盘（须在 app ready 后调用）。
 * @param win 宠物窗口（托盘菜单对它做 show/hide 切换）
 * @returns Tray 实例；创建失败返回 null（不阻塞应用启动）。调用方必须持有引用。
 */
export function createTray(win: BrowserWindow): Tray | null {
  let tray: Tray
  try {
    tray = new Tray(loadTrayImage())
  } catch (err) {
    console.error('[tray] 托盘创建失败：', err)
    return null
  }

  tray.setToolTip('AI 桌面宠物')

  /**
   * 切换宠物窗口显隐（走 fx 域魔法球动画；结果语义不变：可见→隐藏、不可见→显示）。
   * 动画期间重复触发由 fx 域的锁忽略；动画异常/超时有兜底，hide/show 一定生效。
   */
  const toggleVisibility = (): void => {
    if (win.isDestroyed()) return
    if (win.isVisible()) {
      console.log('[tray] 隐藏宠物窗口（魔法球动画）')
      void runHideAnimation(win)
    } else {
      console.log('[tray] 显示宠物窗口（魔法球动画）')
      void runShowAnimation(win)
    }
  }

  /** 构建菜单模板：文案随窗口显隐态更新（可见 → "隐藏宠物"，不可见 → "显示宠物"） */
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
    { type: 'separator' },
    {
      label: '退出',
      // 走既有退出清理链路：app.quit → before-quit 拦截 → backendManager.stop() → 真正退出
      click: () => app.quit()
    }
  ]

  const refreshMenu = (): void => {
    tray.setContextMenu(Menu.buildFromTemplate(buildTemplate()))
  }
  refreshMenu()

  // 窗口显隐（含渲染侧拖拽/快捷键等间接引起的显隐）后刷新菜单文案
  win.on('show', refreshMenu)
  win.on('hide', refreshMenu)

  // 单击=叫它出来（仅显示，不切换）：修复"单击与菜单双路径叠加、两次 toggle 互相抵消"的
  // 静默失效（DDE 下单击/菜单事件来源不可控，成对触发导致看起来没反应）。
  // 隐藏走菜单"隐藏宠物"或 Alt+F4；菜单项仍为 toggle（动态文案，语义清晰）
  tray.on('click', () => {
    if (win.isDestroyed() || win.isVisible()) return
    console.log('[tray] 单击托盘 → 显示宠物窗口（魔法球动画）')
    void runShowAnimation(win)
  })

  console.log('[tray] 托盘已创建（菜单：显示/隐藏宠物、教学模式、退出）')
  return tray
}
