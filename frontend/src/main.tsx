import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './styles.css'
import { initTheme } from './shared/theme'

// 主题（§7.6.4）：应用持久化偏好（深/浅/跟随系统）+ 监听系统与跨窗口变化
// （设置窗切换主题 → BroadcastChannel → 本窗即时变色）
initTheme()

createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
