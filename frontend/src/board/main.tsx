/**
 * 黑板页入口（board.html）：教学模式黑板窗口（board 域）的 React 挂载。
 * 与 fx 域同模式：独立 HTML + 独立 src 目录，共用同一 preload 基建。
 */
import React from 'react'
import { createRoot } from 'react-dom/client'
import 'highlight.js/styles/github-dark.css'
import BoardApp from './BoardApp'
import './board.css'
import { initTheme } from '../shared/theme'

// 主题（§7.6.4）：黑板同享主题变量（浅色成"白板"）；设置窗切换 → 本窗即时变色
initTheme()

createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <BoardApp />
  </React.StrictMode>
)

console.log('[board] 黑板页已就绪')
