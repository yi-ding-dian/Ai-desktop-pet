/**
 * 提醒列表窗入口（reminder-list.html，2026-10-18）。
 * 独立渲染页，与 board/bubble 同模式：主题初始化 + React 挂载。
 */
import React from 'react'
import { createRoot } from 'react-dom/client'
import { initTheme } from '../shared/theme'
import ReminderListApp from './ReminderListApp'
import './reminder-list.css'

initTheme()

createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <ReminderListApp />
  </React.StrictMode>
)

console.log('[reminder-list] 页面已就绪')
