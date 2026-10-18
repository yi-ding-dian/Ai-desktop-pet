/**
 * 窗口 UI 套件（shared/ui）——渲染侧统一出口。
 *
 * 使用方式：
 *   1. 入口 CSS 顶部：@import '../shared/theme/theme.css'; @import '../shared/ui/ui.css';
 *   2. 组件/钩子从本文件导入（见 ui.css 头部的层次说明与类名约定）。
 */
export * from './components'
export { cx } from './classnames'
export { useEscapeStack } from './hooks/useEscapeStack'
export { useFocusTrap } from './hooks/useFocusTrap'
export { useFramelessMove } from './hooks/useFramelessMove'
export type { FramelessMoveHandlers, UseFramelessMoveOptions } from './hooks/useFramelessMove'
export { useFramelessResize } from './hooks/useFramelessResize'
export type {
  FramelessResizeHandlers,
  ResizeEdge,
  UseFramelessResizeOptions
} from './hooks/useFramelessResize'
export { useResizablePanel } from './hooks/useResizablePanel'
export type { ResizablePanelOptions, ResizablePanelResult } from './hooks/useResizablePanel'
