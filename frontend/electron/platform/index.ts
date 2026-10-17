/**
 * 平台层：全项目**唯一**读 `process.platform` 的地方（跨域平台差异的统一出口）。
 *
 * 为什么要有这一层（2026-10-16 收拢）：此前平台判断散在 tray / bubble / teaching / settings /
 * backend-process / main 六个域里，想回答"改 Windows 会不会碰坏 Linux"得逐个文件翻——
 * 收拢后只需看这一个目录 + `window/`。
 *
 * 本层只放两类东西：
 *   ① 平台事实：`PLATFORM` / `isWindows` / `isLinux`；
 *   ② **跨域复用**的平台常量与选项：任务栏身份、仅 Linux 的窗口选项、后端产物名。
 * 域独有的平台行为留在那个域（如 tray 的 DDE 原生菜单、settings 的 X 层探针），只从本层取判定。
 *
 * 与 `window/` 的分工：窗口域按设计文档 §5.1 自带一套按平台分文件的实现
 * （`window/linux.ts` / `win32.ts` / `darwin.ts` + `registry.ts`），那是"一个域内部的分发"；
 * 本层是"跨域共用的事实"。两者都在明处，**新增平台时这两处是完整的检查清单**。
 *
 * 约定（与 registry.ts 同调）：**禁止 `if (isWindows) ... else ...` 式二分假设**；
 * 新增平台 = 本文件补一条，消费方零改动。
 *
 * ⚠ 本文件**不得 import electron**：preload 也要用它，而 preload 里没有 `app` / `BrowserWindow`。
 *   需要 app 的地方（Windows 任务栏身份）走依赖注入——见 `applyWindowsAppIdentity`。
 */
import type { AppIdentityHost, BackendLaunchNames, LinuxOnlyWindowOptions } from './types'

/** 当前平台。全项目只在本行读 `process.platform`（其余一律从这里取）。 */
export const PLATFORM: NodeJS.Platform = process.platform

/** 是否 Windows 平台（注意：与窗口域 `window/` 无关，别混） */
export const isWindows: boolean = PLATFORM === 'win32'

/** 是否 Linux 平台 */
export const isLinux: boolean = PLATFORM === 'linux'

/**
 * Windows 任务栏身份（AppUserModelID）。
 *
 * 必须与 `frontend/electron-builder.yml` 的 `appId` **保持一致**——不一致会让任务栏图标归组、
 * 固定到任务栏后右键菜单指向错误目标。改一处记得改另一处。
 */
export const APP_USER_MODEL_ID = 'com.yicaibao.aipet'

/**
 * 应用 Windows 任务栏身份；非 Windows 直接跳过（Linux/macOS 无此概念）。
 *
 * 时机要求：必须**早于任何窗口创建**。app 由调用方注入（本层不 import electron，见文件头）。
 */
export function applyWindowsAppIdentity(app: AppIdentityHost): void {
  if (!isWindows) return
  app.setAppUserModelId(APP_USER_MODEL_ID)
}

/**
 * 仅 Linux 需要设置的窗口选项；其余平台返回**空对象**——
 * 调用方统一写成 `...linuxOnlyWindowOptions()`，展开空对象等于什么都没加，从而零平台分支。
 */
export function linuxOnlyWindowOptions(): LinuxOnlyWindowOptions {
  return isLinux ? { type: 'toolbar' } : {}
}

/**
 * 气泡窗生命周期策略：
 *  - true（Windows）：隐藏后**复用**同一个窗口/渲染进程。Windows 上「销毁 → 下次重建」
 *    每次右键菜单都要新建渲染进程 + 重新加载 bubble.html（dev 实测菜单弹出约 300ms；
 *    生产构建首次约 170ms）。复用它之后第二次起只需 show + 下发内容（~20-30ms）。
 *  - false（Linux/macOS）：隐藏即销毁、每次唯一 partition 重建——这是 KWin/Chromium
 *    渲染进程坏状态的既有规避手段（见 electron/bubble/index.ts 的完整排查记录）。
 * 新增平台时在这一行补它的策略，消费方（bubble 域）零改动。
 */
export const REUSE_BUBBLE_WINDOW: boolean = isWindows

/**
 * 后端启动路径名（开发态解释器 / 生产态产物名）。非 Windows 一律取类 Unix 形式
 * （Linux 在跑；macOS 未实现但取 Unix 形式是正确方向，将来落地时不必再改这里）。
 */
export const BACKEND_LAUNCH_NAMES: BackendLaunchNames = isWindows
  ? { venvPython: ['Scripts', 'python.exe'], exeName: 'backend.exe' }
  : { venvPython: ['bin', 'python'], exeName: 'backend' }

export type { AppIdentityHost, BackendLaunchNames, LinuxOnlyWindowOptions } from './types'
