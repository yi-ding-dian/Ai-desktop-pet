/**
 * 自绘托盘菜单页入口（tray-menu.html，§7.6.4 v2）：主题初始化 + React 挂载。
 * 与 board/settings 域同模式：独立 HTML + 独立 src 目录，共用同一 preload 基建。
 * 菜单窗为 frameless + 透明的小窗口（尺寸/定位/收起由主进程托管），本页只负责"画"。
 */
import React from 'react'
import { createRoot } from 'react-dom/client'
import { initTheme } from '../shared/theme'
import TrayMenu from './TrayMenu'
import './tray-menu.css'

// 主题先行（首帧防闪烁由 tray-menu.html 的内联脚本兜底，这里接管跨窗变化与系统跟随）
initTheme()

createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <TrayMenu />
  </React.StrictMode>
)

console.log('[tray-menu] 菜单页已就绪')
