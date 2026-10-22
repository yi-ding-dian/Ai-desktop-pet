/**
 * launcher 域（2026-10-19）：已安装应用列表 + 启动程序 IPC。
 *
 * 这是**唯一执行边界**：
 * - `mode:'name'`：渲染进程只传名字，主进程自行扫描开始菜单 `.lnk`（Windows）
 *   或 XDG `.desktop`（Linux）、自行解析目标，不接受渲染进程给的可执行路径；
 * - `mode:'path'`：主进程独立校验可执行文件；`trusted=true`（记忆本登记，用户
 *   亲手添加）免确认，否则弹宠物确认气泡，用户点「运行」才 spawn；
 * - 永远 `shell:false`、参数数组；每 sender 每分钟 10 次限流。
 *
 * 与 `system/path-safety.ts` 的"打开文件拒绝可执行"语义相反，二者不共用判定。
 */

import { app, ipcMain, type BrowserWindow, type WebContents } from 'electron'
import { openConfirmBubble } from '../bubble'
import {
  IPC,
  type LauncherAppEntry,
  type LauncherListRequest,
  type LauncherListResult,
  type LauncherRunRequest,
  type LauncherRunResult
} from '../ipc/channels'
import { isLinux, isWindows } from '../platform'
import { isSettingsSender } from '../settings'
import { execTargetIndex } from './desktop-entry'
import {
  resolveWorkingDirectory,
  spawnDetached,
  validateLaunchableProgram
} from './program-launch'
import { clearAppCache, findApplications, scanApplications, type ScannedApp } from './application-scan'
import { clearWindowsAppCache, scanWindowsApplications } from './windows-apps'

const RATE_LIMIT = 10
const RATE_WINDOW_MS = 60_000

let petWindow: BrowserWindow | null = null
let installed = false
const rateBuckets = new Map<number, number[]>()

function isTrustedSender(sender: WebContents): boolean {
  if (
    petWindow &&
    !petWindow.isDestroyed() &&
    sender.id === petWindow.webContents.id
  ) {
    return true
  }
  return isSettingsSender(sender)
}

function rateLimited(senderId: number, now: number = Date.now()): boolean {
  const recent = (rateBuckets.get(senderId) || []).filter(
    (stamp) => now - stamp < RATE_WINDOW_MS
  )
  if (recent.length >= RATE_LIMIT) {
    rateBuckets.set(senderId, recent)
    return true
  }
  recent.push(now)
  rateBuckets.set(senderId, recent)
  return false
}

function failure(code: string, message?: string): {
  ok: false
  code: string
  message?: string
} {
  return { ok: false, code, message }
}

/**
 * 读取本机已安装应用：Windows 扫开始菜单 `.lnk`，Linux 扫 XDG `.desktop`。
 * 两个平台各自缓存；不支持的平台由调用方先拦掉。
 */
function scanInstalled(options: { refresh?: boolean } = {}): ScannedApp[] {
  return isWindows
    ? scanWindowsApplications({ refresh: options.refresh })
    : scanApplications({ refresh: options.refresh, locale: app.getLocale() })
}

/** 本机应用扫描支持的系统（macOS 未实现） */
const launcherSupported = isWindows || isLinux

function toEntry(appInfo: ScannedApp): LauncherAppEntry {
  return {
    id: appInfo.id,
    name: appInfo.name,
    execPath: appInfo.execPath,
    hasArgs: appInfo.hasArgs,
    needsTerminal: appInfo.needsTerminal,
    available: appInfo.available,
    wrapper: appInfo.wrapper
  }
}

async function handleList(
  sender: WebContents,
  raw: LauncherListRequest | null
): Promise<LauncherListResult> {
  if (!isTrustedSender(sender)) {
    return { ...failure('launcher_forbidden_sender', '无权执行这个操作'), apps: [] }
  }
  if (!launcherSupported) {
    return {
      ...failure(
        'launcher_unsupported_platform',
        '读取已安装应用目前支持 Windows 和 Linux；可以手动填写可执行文件路径'
      ),
      apps: []
    }
  }
  try {
    const apps = scanInstalled({ refresh: raw?.refresh === true })
    return {
      ok: true,
      code: 'launcher_listed',
      apps: apps.map(toEntry).sort((a, b) => a.name.localeCompare(b.name))
    }
  } catch (err) {
    return {
      ...failure(
        'launcher_scan_failed',
        `读取已安装应用失败：${(err as Error).message}`
      ),
      apps: []
    }
  }
}

async function runNamedApp(
  name: string
): Promise<LauncherRunResult> {
  let match = findApplications(scanInstalled(), name)
  if (!match.match && !match.candidates.length && !match.unavailable) {
    // 可能是刚安装的应用：强制重扫一次
    match = findApplications(scanInstalled({ refresh: true }), name)
  }

  if (match.candidates.length) {
    return {
      ok: false,
      code: 'launcher_ambiguous',
      message: `找到多个叫『${name}』的应用：${match.candidates
        .map((item) => item.name)
        .join('、')}。请说得更具体一点。`,
      candidates: match.candidates.map((item) => item.name)
    }
  }
  if (match.unavailable) {
    return {
      ok: false,
      code: 'launcher_unavailable',
      message: `『${match.unavailable.name}』的程序文件找不到了（可能已卸载）。`
    }
  }
  const found = match.match
  if (!found) {
    return {
      ok: false,
      code: 'launcher_not_found',
      message: isWindows
        ? `没有找到名叫『${name}』的已安装应用（微软商店应用暂不支持）。可以在设置 → 记忆本里登记程序路径。`
        : `没有找到名叫『${name}』的已安装应用。可以在设置 → 记忆本里登记程序路径。`
    }
  }
  if (!found.available || !found.execPath) {
    return {
      ok: false,
      code: 'launcher_unavailable',
      message: `『${found.name}』的程序文件找不到了（可能已卸载）。`
    }
  }
  if (found.needsTerminal) {
    return {
      ok: false,
      code: 'launcher_requires_terminal',
      message: `『${found.name}』是终端应用，小兔现在还不能在终端里启动它。`
    }
  }
  if (isWindows && found.wrapper) {
    return {
      ok: false,
      code: 'launcher_requires_shell',
      message: `『${found.name}』需要通过开始菜单启动，小兔不能直接启动它。`
    }
  }

  const targetIndex = execTargetIndex(found.execArgv)
  const args = targetIndex >= 0 ? found.execArgv.slice(targetIndex + 1) : []
  const result = await spawnDetached(found.execPath, args, {
    cwd: resolveWorkingDirectory(found.workingDir)
  })
  if (!result.ok) {
    return { ok: false, code: result.code, message: result.message }
  }
  return { ok: true, code: 'launcher_started', appName: found.name }
}

async function runPath(
  rawPath: string,
  displayName: string,
  trusted: boolean
): Promise<LauncherRunResult> {
  const check = validateLaunchableProgram(rawPath)
  if (!check.ok || !check.path) {
    return { ok: false, code: check.code, message: check.message }
  }
  const label = displayName || check.path.split(/[\\/]/).pop() || check.path

  let confirmed = true
  if (!trusted) {
    try {
      confirmed = await openConfirmBubble({
        message: `要启动「${label}」吗？`,
        confirmLabel: '运行',
        cancelLabel: '取消'
      })
    } catch {
      return {
        ok: false,
        code: 'launcher_confirm_unavailable',
        message: '确认气泡没弹出来，再试一次好吗？'
      }
    }
    if (!confirmed) {
      return {
        ok: false,
        confirmed: false,
        code: 'launcher_cancelled',
        message: '好，不运行了。'
      }
    }
  }

  const result = await spawnDetached(check.path, [], {
    cwd: resolveWorkingDirectory('')
  })
  if (!result.ok) {
    return { ok: false, confirmed, code: result.code, message: result.message }
  }
  return {
    ok: true,
    confirmed: trusted ? undefined : true,
    code: 'launcher_started',
    appName: label
  }
}

async function handleRun(
  sender: WebContents,
  raw: LauncherRunRequest | null
): Promise<LauncherRunResult> {
  if (!isTrustedSender(sender)) {
    return failure('launcher_forbidden_sender', '无权执行这个操作')
  }
  if (!launcherSupported) {
    return failure(
      'launcher_unsupported_platform',
      '启动本机程序目前支持 Windows 和 Linux'
    )
  }
  if (rateLimited(sender.id)) {
    return failure('launcher_rate_limited', '启动太频繁了，稍等一下再试。')
  }
  if (!raw || typeof raw !== 'object') {
    return failure('launcher_bad_request', '启动参数不正确')
  }

  if (raw.mode === 'name') {
    const name = typeof raw.name === 'string' ? raw.name.trim() : ''
    if (!name || name.length > 200) {
      return failure('launcher_bad_request', '应用名不正确')
    }
    return runNamedApp(name)
  }

  if (raw.mode === 'path') {
    const path = typeof raw.path === 'string' ? raw.path.trim() : ''
    const name = typeof raw.name === 'string' ? raw.name.trim().slice(0, 80) : ''
    if (!path || path.length > 4096) {
      return failure('launcher_bad_request', '程序路径不正确')
    }
    return runPath(path, name, raw.trusted === true)
  }

  return failure('launcher_bad_request', '启动参数不正确')
}

/** 注册 launcher IPC（幂等；由 main 在宠物窗创建后调用一次） */
export function initLauncher(win: BrowserWindow): void {
  petWindow = win
  if (installed) return
  installed = true
  ipcMain.handle(IPC.LAUNCHER_LIST_APPS, (event, raw: LauncherListRequest | null) =>
    handleList(event.sender, raw)
  )
  ipcMain.handle(IPC.LAUNCHER_RUN, (event, raw: LauncherRunRequest | null) =>
    handleRun(event.sender, raw)
  )
}

/** 退出清理（移除 handler、清缓存/限流桶） */
export function destroyLauncher(): void {
  if (!installed) return
  installed = false
  petWindow = null
  ipcMain.removeHandler(IPC.LAUNCHER_LIST_APPS)
  ipcMain.removeHandler(IPC.LAUNCHER_RUN)
  rateBuckets.clear()
  clearAppCache()
  clearWindowsAppCache()
}
