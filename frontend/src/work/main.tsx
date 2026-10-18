/**
 * 工作模式入口（work.html）：主题初始化 + React 挂载。
 * 与 board/settings 同模式：独立 HTML + 独立 src 目录，共用同一 preload 基建。
 */
import React from 'react'
import { createRoot } from 'react-dom/client'
import 'highlight.js/styles/github-dark.css'
import { initTheme } from '../shared/theme'
import WorkApp from './WorkApp'
import './work.css'

// 主题（§7.6.4）：设置窗切换 → 本窗即时变色；首帧防闪烁由 work.html 内联脚本兜底
initTheme()

// 刻意不用 StrictMode：本窗口的 effect 会发起“就绪握手 + 历史回填”IPC，
// 开发态双挂载会重复请求（StrictMode 的模拟卸载还会清掉订阅），收益不足以抵消噪声。
createRoot(document.getElementById('root') as HTMLElement).render(<WorkApp />)

console.log('[work] 工作模式页已就绪')
