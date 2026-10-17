/**
 * 光标坐标源：click-through 的坐标抽象（统一接口 + 降级组合 + 平台解析）。
 *
 * 背景（X11 实测，详见 click-through.ts 文件头实测备忘）：
 *  - `screen.getCursorScreenPoint()` 在 X11 下是**事件驱动缓存**（指针位于外部窗口时不更新）
 *    → 数据"不实时"，需脉冲刷新才有感知（脉冲窗口有丢击概率）；
 *  - `xdotool getmouselocation`（XQueryPointer 实时查询）**零丢击且成本可接受** → Linux 首选源
 *    （见 xdotool-cursor-source.ts；XI2 事件流路线经实测被窗口截获，已弃用——同文件有完整记录）。
 * 因此坐标经本接口注入 click-through：isLive() 标记数据实时性——非实时源由 click-through 启用脉冲兜底
 * （fallback）；首选源不可用时经组合器自动降级（运行时一次判定，日志明示）。
 *
 * 坐标空间：xdotool/XQueryPointer 返回的 root 坐标与 Electron 窗口/光标坐标空间一致（实测环境
 * scaleFactor=1 下逐点匹配；Linux 无 screenToDipPoint 运行时 API——实测调用报 not a function，勿用）。
 */
import { PLATFORM } from '../platform'
import type { Point } from './index'
import { createXdotoolCursorSource } from './xdotool-cursor-source'

/** 光标坐标源（click-through 依赖的最小接口） */
export interface ClickThroughCursorSource {
  /** 读取当前光标屏幕坐标；null = 暂不可知（源未就绪/尚无数据，调用方跳过本轮） */
  read(): Point | null
  /** true = 实时源（XI2 流，无需脉冲刷新）；false = 事件驱动缓存（需脉冲刷新，见 click-through 文件头） */
  isLive(): boolean
  /** 是否已判定**永久不可用**（供降级组合器切换；可选，缺省视为可用） */
  isFailed?(): boolean
  /** 启动数据源（幂等；click-through 在启动/恢复时调用） */
  start(): void
  /** 停止数据源并清理（幂等；click-through 在停止/守卫暂停时调用——不可见时停子进程省开销） */
  stop(): void
}

/**
 * screen API 源：读 `screen.getCursorScreenPoint()`。
 *
 * 实时性**随平台而异**（这是 isLive 的取值依据，不是统一常量）：
 *  - X11：事件驱动缓存（指针在外部窗口时不更新）→ isLive=false，click-through 启用脉冲刷新；
 *  - Windows/macOS：`GetCursorPos` 式实时查询，取到即当前值 → isLive=true，
 *    **不得**启用脉冲（脉冲会周期性关掉输入让路，白白制造丢击窗口）。
 */
export function createScreenCursorSource(
  getCursor: () => Point,
  isLive = false
): ClickThroughCursorSource {
  return {
    read: () => getCursor(),
    isLive: () => isLive,
    start: () => {},
    stop: () => {}
  }
}

/**
 * 降级组合器：primary 判定失败（isFailed()）→ **一次会话内永久**切 fallback（日志明示；
 * 重启应用可重试）。primary 未失败时只用 primary（不混读两源，避免坐标系/新鲜度跳变）。
 */
export function createDegradableCursorSource(
  primary: ClickThroughCursorSource,
  fallback: ClickThroughCursorSource,
  log: (msg: string) => void
): ClickThroughCursorSource {
  let degraded = false
  const shouldDegrade = (): boolean => {
    if (!degraded && (primary.isFailed?.() ?? false)) {
      degraded = true
      log('[window/cursor-source] 首选光标源（xdotool 实时查询）不可用 → 降级为 screen 轮询 + 脉冲方案（丢击窗口回归；重启应用可重试）')
    }
    return degraded
  }
  return {
    read: () => (shouldDegrade() ? fallback.read() : primary.read()),
    isLive: () => (shouldDegrade() ? fallback.isLive() : primary.isLive()),
    start: () => {
      primary.start()
      fallback.start()
    },
    stop: () => {
      primary.stop()
      fallback.stop()
    }
  }
}

export interface ResolveCursorSourceOptions {
  /** screen API 取值函数（降级源用；主进程传 () => screen.getCursorScreenPoint()） */
  screenGetCursor(): Point
  /** 平台（缺省取 electron/platform 的 PLATFORM；显式传参便于测试） */
  platform?: NodeJS.Platform
  /** 日志（缺省 console.log） */
  log?(msg: string): void
}

/** 平台解析：Linux → xdotool 实时查询（失败自动降级）；其余平台 → screen 源（Windows/macOS 的 getCursorScreenPoint 为实时查询，无此坑） */
export function resolveCursorSource(opts: ResolveCursorSourceOptions): ClickThroughCursorSource {
  const platform = opts.platform ?? PLATFORM
  // screen 源的实时性**按平台定**（见 createScreenCursorSource 注释）：
  //  - 非 Linux：本函数返回的就是它本身（Windows/macOS 无 X11 缓存坑）→ isLive=true，无脉冲；
  //  - Linux：它只是 xdotool 的首选源失败后的降级源 → isLive=false，仍需脉冲刷新 X11 缓存。
  const fallback = createScreenCursorSource(opts.screenGetCursor, platform !== 'linux')
  if (platform !== 'linux') return fallback
  const log = opts.log ?? ((msg: string) => console.log(msg))
  return createDegradableCursorSource(createXdotoolCursorSource({ log }), fallback, log)
}
