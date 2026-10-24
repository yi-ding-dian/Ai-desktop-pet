/**
 * IPC 通道定义（主进程 ↔ 渲染进程的单一事实来源）。
 *
 * 按域拆分：通道名在 names.ts，载荷与 API 按业务域各一文件；
 * 本文件只做聚合再导出，外部仍按 electron/ipc/channels 引用。
 */
export * from './agent'
export * from './api'
export * from './backend'
export * from './ball-animation'
export * from './bubble'
export * from './files'
export * from './launcher'
export * from './names'
export * from './reminder'
export * from './settings'
export * from './system'
export * from './teaching'
export * from './window'
export * from './work'
