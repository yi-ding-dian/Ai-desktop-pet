/**
 * 设置窗"健康探针"（Linux/X11）——检测 X 层窗口是否仍存在。
 *
 * 背景（2026-10-15 独立实验实测，Electron 33 + DDE/X11）：**外部强杀**（xdotool windowclose
 * 的 XDestroyWindow、WM 异常等）在 Electron 侧完全不可见——不触发 close/closed/
 * webContents-destroyed 任何事件；isDestroyed / isVisible / isFocused /
 * webContents.isDestroyed 全部保持假值（与正常窗口无异）；capturePage 也无区分度。
 * 唯一可靠信号 = win.getNativeWindowHandle() 的 XID 在 X 服务器上是否仍存在
 * （xwininfo 查询：exit 0 = 存在；"No such window" = 已消失）。
 *
 * 用途（settings/index.ts 两道防线）：
 *  - openSettings 的"已存在"分支前置校验：死窗清理重建（绝不聚焦死窗）；
 *  - 打开期间低频巡检（startHealthWatch）：死窗 → 清理引用 + destroy（closed 链 → 回位广播）。
 *
 * 防误判纪律：任何"无法检测"的情形（非 Linux / Wayland 会话 / XID 缺失 / xwininfo 命令
 * 不存在 / 超时）一律返回 null——调用方按"无法判断"处理（保持既有行为），绝不推断为死窗。
 */
import { execFile } from 'node:child_process'
import type { BrowserWindow } from 'electron'
import { isLinux } from '../platform'

/** 探测结果：true = X 窗口存在；false = 已消失（死窗）；null = 无法检测（不误判） */
export type XWindowAlive = boolean | null

/** 取窗口的 X11 XID（仅 Linux/X11 有意义；Buffer 前 4 字节小端） */
function getXWindowId(win: BrowserWindow): number | null {
  try {
    const buf = win.getNativeWindowHandle()
    if (!buf || buf.length < 4) return null
    return buf.readUInt32LE(0)
  } catch {
    return null
  }
}

/**
 * 探测窗口在 X 层是否仍存在。
 * 门控：仅 Linux 且非 Wayland 会话（Wayland 下 XID 语义不同——宁可不检测也不误杀）。
 */
export function probeXWindowAlive(win: BrowserWindow): Promise<XWindowAlive> {
  if (!isLinux || process.env['WAYLAND_DISPLAY']) {
    return Promise.resolve(null)
  }
  const xid = getXWindowId(win)
  if (xid === null) return Promise.resolve(null)
  return new Promise((resolve) => {
    execFile('xwininfo', ['-id', String(xid)], { timeout: 1500 }, (err, stdout, stderr) => {
      if (!err) {
        resolve(true)
        return
      }
      // 窗口不存在：xwininfo 退出码 1 + "xwininfo: error: No such window with id 0x..."
      const msg = `${String(stderr)} ${String(stdout)} ${String(err.message)}`
      if (/No such window/i.test(msg)) {
        resolve(false)
        return
      }
      // 命令缺失（ENOENT）/超时/其它错误：不可检测（决不当成死窗）
      resolve(null)
    })
  })
}
