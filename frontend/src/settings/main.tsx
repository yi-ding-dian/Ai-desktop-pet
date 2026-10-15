/**
 * 设置页入口（settings.html）：主题初始化 + React 挂载。
 * 与 board/fx 域同模式：独立 HTML + 独立 src 目录，共用同一 preload 基建。
 * 数据流见 hooks/useSettingsController（自持 WS 连接，§7.6.2）。
 */
import React from 'react'
import { createRoot } from 'react-dom/client'
import { initTheme } from '../shared/theme'
import SettingsApp from './SettingsApp'
import './settings.css'

// 主题先行（首帧防闪烁由 settings.html 的内联脚本兜底，这里接管后续系统/跨窗变化）
initTheme()

createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <SettingsApp />
  </React.StrictMode>
)

console.log('[settings] 设置页已就绪')
