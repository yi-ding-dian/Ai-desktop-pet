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
  // 渲染进程：index.html（宠物窗口）与 fx.html（魔法球动画窗）两个入口（对齐设计文档 §2.2）
  renderer: {
    root: '.',
    plugins: [react()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'index.html'),
          // 第二渲染入口：魔法球捕获动画（fx 域球窗的页面）
          fx: resolve(__dirname, 'fx.html')
        }
      }
    }
  }
})
