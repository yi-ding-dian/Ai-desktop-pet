/**
 * 窗口实现注册表：按平台选择实现（设计文档 §5.1）。平台取值来自 electron/platform。
 *
 * 约定：新增平台 = 新增一个实现文件 + 此处注册一行，调用方零改动。
 * 禁止 if (isWindows) else 式二分假设。
 */
import { PLATFORM } from '../platform'
import type { PetWindowOptions, PlatformWindow } from './index'
import { createLinuxWindow } from './linux'
import { createWin32Window } from './win32'
import { createDarwinWindow } from './darwin'

export type WindowImplFactory = (opts: PetWindowOptions) => PlatformWindow

/** 平台实现注册表（未注册平台回退到通用降级实现） */
const REGISTRY: Readonly<Partial<Record<NodeJS.Platform, WindowImplFactory>>> = {
  linux: createLinuxWindow,
  win32: createWin32Window,
  // macOS 本期不做实现（设计文档：未实现时返回降级实现——不透明窗口、无穿透）
  darwin: createDarwinWindow
}

/** 解析当前平台实现；`platform` 参数仅为可测试性暴露，缺省取 electron/platform 的 PLATFORM */
export function resolveWindowImpl(platform: NodeJS.Platform = PLATFORM): WindowImplFactory {
  const impl = REGISTRY[platform]
  if (impl) return impl
  console.warn(`[window/registry] 平台 "${platform}" 无专用实现，回退到通用降级实现（不透明窗口、无穿透）`)
  return createDarwinWindow
}
