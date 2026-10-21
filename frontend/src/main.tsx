import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './styles.css'
import { initTheme } from './shared/theme'
import { setupPetScale } from './shared/pet-scale'

// 主题（§7.6.4）：应用持久化偏好（深/浅/跟随系统）+ 监听系统与跨窗口变化
// （设置窗切换主题 → BroadcastChannel → 本窗即时变色）
initTheme()

// 宠物缩放（2026-10-21）：首帧档位来自 URL query（主进程按持久化档位建窗时带上），
// 运行时变更由主进程 IPC 推送 → 写 CSS 变量 --pet-scale（画布/教学气泡布局据此派生）
setupPetScale()

createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
