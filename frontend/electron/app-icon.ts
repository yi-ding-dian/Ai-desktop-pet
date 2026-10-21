/**
 * 应用图标素材解析（2026-10-21）。
 *
 * 素材唯一源：`frontend/build/icon.png`（兔子头像）——托盘、打包（electron-builder
 * linux/win icon）、窗口、系统通知共用同一张，避免多份副本漂移。
 *
 * 路径两态与 tray 域一致：
 *  - 开发态：app.getAppPath()/build/icon.png（electron-vite dev 下 appPath = frontend/）；
 *  - 打包态：process.resourcesPath/tray-icon.png（electron-builder.yml 的 extraResources
 *    从 build/icon.png 拷入，见该文件注释）。
 */
import { app } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/** 当前运行态的图标绝对路径；两态都不存在时返回 undefined（调用方降级为默认图标） */
export function resolveAppIconPath(): string | undefined {
  const candidate = app.isPackaged
    ? join(process.resourcesPath, 'tray-icon.png')
    : join(app.getAppPath(), 'build', 'icon.png')
  return existsSync(candidate) ? candidate : undefined
}
