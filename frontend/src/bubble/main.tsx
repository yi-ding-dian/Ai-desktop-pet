/**
 * 气泡页入口（bubble.html）：气泡窗（bubble 域）的 React 挂载。
 * 与 board/fx/tray-menu 域同模式：独立 HTML + 独立 src 目录，共用同一 preload 基建。
 * 窗口为 frameless + 透明的动态小窗（尺寸/定位/收起由主进程托管），本页只负责"画"。
 */
import React from 'react'
import { createRoot } from 'react-dom/client'
import { initTheme } from '../shared/theme'
import BubbleApp from './BubbleApp'
import './bubble.css'

// 主题先行（首帧防闪烁由 bubble.html 的内联脚本兜底，这里接管跨窗变化与系统跟随）
initTheme()

createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <BubbleApp />
  </React.StrictMode>
)

console.log('[bubble] 气泡页已就绪')
