/** 已安装应用条目（launcher 域；2026-10-19） */
export interface LauncherAppEntry {
  /** 应用 id（Linux desktop id / Windows 相对快捷方式路径；子目录用 '-' 连接） */
  id: string
  /** 显示名（Linux 按 locale 本地化；Windows 取快捷方式文件名） */
  name: string
  /** 启动目标解析后的绝对路径；'' = 无法定位 */
  execPath: string
  /** 去掉字段码后仍有字面参数（设置页选择器回填时的提示依据） */
  hasArgs: boolean
  needsTerminal: boolean
  available: boolean
  /** flatpak/snap/env 等 wrapper：单独启动程序本体没有意义 */
  wrapper: boolean
}

export interface LauncherListRequest {
  refresh?: boolean
}

export interface LauncherListResult {
  ok: boolean
  code: string
  message?: string
  apps: LauncherAppEntry[]
}

/**
 * 启动请求：
 * - `name`：按已安装应用名匹配（主进程自行扫描开始菜单 .lnk / XDG .desktop，
 *   渲染进程不能传路径）；
 * - `path`：直接启动一个可执行文件。`trusted=true` 表示来自记忆本登记条目
 *   （免确认）；用户临时给出的路径必须为 false，主进程会弹确认气泡。
 */
export type LauncherRunRequest =
  | { mode: 'name'; name: string }
  | { mode: 'path'; path: string; name?: string; trusted: boolean }

export interface LauncherRunResult {
  ok: boolean
  /** path 模式：是否经过用户确认；用户取消时为 false */
  confirmed?: boolean
  code: string
  message?: string
  appName?: string
  /** 重名候选（最多 5 个） */
  candidates?: string[]
}
