/**
 * 宠物缩放档位（渲染层，2026-10-21）：把当前档位同步到 CSS 变量 `--pet-scale`。
 *
 * 首帧档位来自 URL query（主进程建窗时按持久化档位 loadFile/loadURL 带上 `petScale`，
 * 避免 1.0 → 档位的可见跳变）；运行时变更由主进程经 IPC_EVENTS.PET_SCALE_CHANGED 推送。
 *
 * 约定：只缩放兔子画布（.pet-canvas-mount），输入框/气泡/提醒面板等 UI 尺寸不变，
 * 位置以 `--pet-scale` 参与 calc 派生（见 styles.css）。
 */
import { getPetBridge } from '../pet-bridge'

/** 与主进程 window/index.ts 的 PET_SCALE_STEPS 保持一致（IPC 边界两侧各存一份） */
const PET_SCALE_STEPS = [0.8, 0.9, 1.0, 1.1, 1.2] as const

let currentScale = 1.0

/** 是否为支持档位（浮点安全） */
export function isPetScale(value: unknown): value is number {
  return typeof value === 'number' && PET_SCALE_STEPS.some((s) => Math.abs(s - value) < 1e-6)
}

/** 当前档位（同步读取；教学气泡等按窗口坐标计算的组件用） */
export function getPetScale(): number {
  return currentScale
}

/** 从 URL query 读取首帧档位（无/非法时 1.0） */
export function readInitialPetScale(): number {
  try {
    const raw = Number(new URLSearchParams(window.location.search).get('petScale'))
    if (isPetScale(raw)) currentScale = raw
  } catch {
    // 非浏览器环境/异常 query：保持 1.0
  }
  return currentScale
}

/** 应用档位：写 CSS 变量（styles.css 的画布/教学气泡布局据此派生） */
export function applyPetScale(scale: number): void {
  if (!isPetScale(scale)) return
  currentScale = scale
  document.documentElement.style.setProperty('--pet-scale', String(scale))
}

/**
 * 初始化（宠物窗入口调用一次）：读 query → 应用 → 订阅运行时变更。
 * 返回取消订阅函数（应用生命周期内一般不需要调用）。
 */
export function setupPetScale(): () => void {
  applyPetScale(readInitialPetScale())
  // 旧 preload 无该通道时静默降级（固定 1.0 布局）
  return getPetBridge().window.onPetScaleChanged?.(applyPetScale) ?? (() => {})
}
