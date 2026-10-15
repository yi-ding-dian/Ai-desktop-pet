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
  // settings.html（设置窗口）四个入口（对齐设计文档 §2.2、§7.5.2 与 §7.6.1）
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
          settings: resolve(__dirname, 'settings.html')
        }
      }
    }
  }
})
