import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  // 主进程入口：electron/main.ts（目录结构见设计文档 §2.2）
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { main: resolve(__dirname, 'electron/main.ts') }
      }
    }
  },
  // 预加载脚本入口
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { preload: resolve(__dirname, 'electron/preload.ts') }
      }
    }
  },
  // 渲染进程：index.html（宠物窗口）/ fx.html（魔法球动画窗）/ board.html（教学模式黑板）/
  // settings.html（设置窗口）/ tray-menu.html（自绘托盘菜单）/ bubble.html（气泡窗）六个入口
  //（对齐设计文档 §2.2、§7.5.2、§7.6.1、§7.6.4 v2 与气泡系统）
  renderer: {
    root: '.',
    plugins: [react()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'index.html'),
          // 第二渲染入口：魔法球捕获动画（fx 域球窗的页面）
          fx: resolve(__dirname, 'fx.html'),
          // 第三渲染入口：教学模式黑板（board 域黑板窗的页面，设计文档 §7.5.2）
          board: resolve(__dirname, 'board.html'),
          // 第四渲染入口：设置窗口（settings 域设置页，设计文档 §7.6.1）
          settings: resolve(__dirname, 'settings.html'),
          // 第五渲染入口：自绘托盘菜单（tray-menu 域菜单窗的页面，设计文档 §7.6.4 v2）
          'tray-menu': resolve(__dirname, 'tray-menu.html'),
          // 第六渲染入口：气泡窗（bubble 域；用户定稿"气泡系统"第一步——右键菜单/清空确认/说话气泡）
          bubble: resolve(__dirname, 'bubble.html')
        }
      }
    }
  }
})
