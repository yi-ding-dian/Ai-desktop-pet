/**
 * 设置页入口（settings.html）：主题初始化 + React 挂载 + 真机排障探针。
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

// ------------------------------------------------------------------ 真机排障探针（仅 dev）
//
// 背景：真机曾报"内容区点击无响应"（Playwright 无法复现）。此处留证据链：
//  - 每次 pointerdown（捕获阶段，先于任何元素处理）打一行日志 → 转发进主进程日志（/tmp/pet-dev.log）；
//  - 同时收集页面错误到 window.__uiErrors（devtools console 可查"JS 是否半死"）。
// 复现时按日志判断：无 pointerdown = 事件未达页面（窗口/系统层）；落点不是按钮 = 被元素遮挡（类名直接可见）。
if (import.meta.env.DEV) {
  const probe = window as unknown as Record<string, unknown>
  const errors: string[] = []
  probe.__uiErrors = errors
  const pushError = (line: string): void => {
    errors.push(line)
    if (errors.length > 50) errors.shift() // 只留最近 50 条，防长时间会话内存增长
  }
  window.addEventListener('error', (event) => {
    pushError(`[error] ${event.message} @ ${event.filename}:${event.lineno}`)
  })
  window.addEventListener('unhandledrejection', (event) => {
    pushError(`[rejection] ${String((event as PromiseRejectionEvent).reason)}`)
  })
  window.addEventListener(
    'pointerdown',
    (event) => {
      const target = event.target as HTMLElement | null
      const desc = target ? `${target.tagName}.${String(target.className || '').slice(0, 60)}` : '?'
      console.log(`[settings] pointerdown @(${event.clientX},${event.clientY}) → ${desc}`)
    },
    true
  )
}

createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <SettingsApp />
  </React.StrictMode>
)

console.log('[settings] 设置页已就绪')
