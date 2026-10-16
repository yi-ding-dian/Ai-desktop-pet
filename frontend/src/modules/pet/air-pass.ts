/**
 * 空气让路 · 像素级命中（渲染侧接入；设计文档 §5.1 增补块，终版交互）。
 *
 * 解决场景：矩形 hitbox 四角/两侧的透明空气也会吃鼠标（用户实反馈：想点宠物旁边的
 * 文件点不到）。渲染侧负责"光标下是实体还是空气"的判定与上报，主进程输入接管状态机
 * （TAKEN 接管 / YIELDED 让路）据此在**变化时**切点击穿透。
 *
 * 判定链（统一入口 isSolidAt，优先级与设计文档一致）：
 *   ① 交互 DOM 优先：`document.elementFromPoint` 命中"页面交互物"（聊天面板/输入/按钮/
 *      教学气泡等）→ 实体（避免在输入框上打字被误判空气让路）；
 *   ② 否则调 `renderer.hitTest(x,y)`（glb-model = Three 射线打模型网格）；
 *   ③ 渲染器未实现 hitTest → 恒"实体"（fallback = 现状整窗接管，零回归）。
 * 注：preload 尚无上报通道（reportHitTest）时同样保持 fallback——渲染侧可先于主进程合入。
 *
 * 两条驱动源（渲染侧不感知主进程状态，两源天然幂等——都走"判定 → 变化才上报"）：
 *   - TAKEN（窗口收得到鼠标事件）：window pointermove，节流 ~60ms（含尾部补偿——
 *     移动停下后的最后位置必被判定，防止"停在空气上"漏让路）；
 *   - YIELDED（已被让路，收不到窗口事件）：`window.onPointerPos` 主进程轮询推送的
 *     窗口内坐标（null=光标出窗，保持现状）。
 *
 * 拖拽/按住（左键 pointerdown 到抬起）：恒"实体"——按下时重申一次并把判定悬置到
 * 抬起，保证拖拽中途窗口不被让路（事件丢失会直接断拖拽）；**轻点**（无移动）不产生
 * 上报，不会打断正在生效的让路。摸头点击判定不在此模块（仍在 PetView，行为不变）。
 *
 * 与旧悬停逻辑的关系：本模块激活（渲染器实现 hitTest）时，App.tsx 旧"hitbox 进出切
 * clickThrough"逻辑经 `isAirPassActive()` 短路停用——输入全权交主进程状态机，避免双源
 * 打架；未激活时旧逻辑照常（fallback）。挂载/卸载由 PetView 驱动（见 PetView.tsx）。
 */
import type { PetRenderer } from './renderers'
import { getPetBridge } from '../../shared/pet-bridge'

/** dev 态日志（转发到主进程日志，便于无 devtools 验证）；生产构建自动剔除 */
const devLog = (msg: string): void => {
  if (import.meta.env.DEV) console.log(`[pet] ${msg}`)
}

/** 判定节流（ms）：pointermove 频率远高于判定所需（任务约定 ~60ms 一发） */
const HIT_TEST_THROTTLE_MS = 60

/** 宠物渲染区（App.tsx 的 hitbox 容器，PetView 挂在其内）：命中其内元素 = 渲染区，交渲染器像素判定 */
const PET_ZONE_SELECTOR = '.pet-canvas-mount'

/** 纯布局根容器（透明窗口铺满视口、无任何交互）：命中它们 = 空气，同样交渲染器判定 */
const LAYOUT_ROOT_SELECTOR = '.app-root'

/** 空气让路是否已激活（当前渲染器实现 hitTest 且已接线）：App 旧悬停逻辑据此短路 */
let active = false

/** 当前渲染器（判定链入口；未挂载为 null） */
let renderer: PetRenderer | null = null

/** 最近一次已上报的判定（变化才上报；null = 尚未上报过） */
let lastSolid: boolean | null = null

/** 左键按住中（摸头/拖拽/面板操作）：期间恒"实体"、不判定不让路 */
let pointerHeld = false

/** 供 App 判断是否停用旧"hitbox 进出切 clickThrough"逻辑（见文件头） */
export function isAirPassActive(): boolean {
  return active
}

/**
 * 判定链统一入口：该窗口内坐标点是"实体"还是"空气"。
 * @param x 窗口内 CSS 像素 x（视口坐标，即 clientX）
 * @param y 窗口内 CSS 像素 y（视口坐标，即 clientY）
 * 注：导出供调试/测试与将来复用；常规调用方（事件接线）在本模块内。
 */
export function isSolidAt(x: number, y: number): boolean {
  if (isInteractiveDomAt(x, y)) return true
  // 渲染器未实现 hitTest → undefined → 恒 true（fallback = 现状行为）
  return renderer?.hitTest?.(x, y) ?? true
}

/** 光标下是否有"页面交互物"（聊天面板/输入/按钮/教学气泡等）：宠物渲染区与布局根不算 */
function isInteractiveDomAt(x: number, y: number): boolean {
  const el = document.elementFromPoint(x, y)
  if (!el) return false
  // 宠物渲染区（hitbox 容器 / canvas / SVG 表情层）→ 交渲染器像素判定（"空气让路"的落点）
  if (el.closest(PET_ZONE_SELECTOR)) return false
  // 铺满窗口的纯布局容器（透明、无交互；pointer-events:none 的装饰层不会命中到这里）→ 空气
  if (el === document.documentElement || el === document.body || el.id === 'root') return false
  if (el.matches(LAYOUT_ROOT_SELECTOR)) return false
  return true
}

/**
 * 安装空气让路（PetView 挂载渲染器后调用）：
 * 渲染器未实现 hitTest（或 preload 无上报通道）时为零接线（不监听、不上报），
 * 返回的卸载函数仅清理引用。
 * @returns 卸载函数（PetView 卸载渲染器前调用）
 */
export function setupAirPass(r: PetRenderer): () => void {
  const bridge = getPetBridge()
  renderer = r
  // 激活条件：渲染器实现 hitTest 且 preload 已具备上报通道（主进程侧先行的契约；
  // 早期 preload 无 reportHitTest 时自动保持旧悬停逻辑——渲染侧可先合入、主进程到位后自动切换）
  active = typeof r.hitTest === 'function' && typeof bridge.window.reportHitTest === 'function'
  if (!active) {
    devLog('空气让路：渲染器未实现 hitTest 或桥未就绪 → 保持旧悬停逻辑（fallback）')
    return () => {
      if (renderer === r) renderer = null
    }
  }

  let disposed = false
  /** 上次执行判定的时刻（节流依据） */
  let lastRunAt = 0
  /** 节流窗口内的尾部补偿定时器与待判坐标 */
  let trailingTimer = 0
  let trailingPoint: { x: number; y: number } | null = null

  /** 上报（变化才发，避免高频打扰主进程状态机） */
  const report = (solid: boolean): void => {
    if (solid === lastSolid) return
    lastSolid = solid
    bridge.window.reportHitTest?.(solid) // 旧 preload 无该方法时静默（主进程侧未接线则保持现状）
    devLog(`hit-test -> ${solid ? '实体' : '空气'}`)
  }

  /** 执行判定链并上报 */
  const evaluate = (x: number, y: number): void => {
    lastRunAt = performance.now()
    report(isSolidAt(x, y))
  }

  const onPointerMove = (e: PointerEvent): void => {
    if (pointerHeld) return // 按住/拖拽中：不判不让路（按下时已重申"实体"，主进程保持接管）
    const now = performance.now()
    if (now - lastRunAt >= HIT_TEST_THROTTLE_MS) {
      evaluate(e.clientX, e.clientY)
      return
    }
    // 节流窗口内：合并为一次尾部补偿判定——保证移动停下后的最后位置必被判定
    trailingPoint = { x: e.clientX, y: e.clientY }
    if (!trailingTimer) {
      trailingTimer = window.setTimeout(() => {
        trailingTimer = 0
        const p = trailingPoint
        trailingPoint = null
        if (!disposed && !pointerHeld && p) evaluate(p.x, p.y)
      }, Math.max(1, HIT_TEST_THROTTLE_MS - (now - lastRunAt)))
    }
  }

  // 按住（摸头/拖拽起点/面板操作）：恒"实体"——先重申一次（拖拽中途窗口若被让路会丢事件断拖拽），
  // 期间 pointermove 直接跳过判定（见 onPointerMove 顶部），抬起/失焦后恢复。
  const onPointerDown = (e: PointerEvent): void => {
    if (e.button !== 0 || pointerHeld) return
    pointerHeld = true
    report(true)
  }
  const onPointerRelease = (e: PointerEvent): void => {
    if (!pointerHeld) return
    pointerHeld = false
    // 抬起即恢复判定一次：按住期间判定被悬置，若用户"从面板划过空气后原地松手"（无后续
    // pointermove）就等不到重判——这里补一次，让路状态立即跟上（视口外坐标则跳过）
    if (
      e.clientX >= 0 &&
      e.clientY >= 0 &&
      e.clientX < window.innerWidth &&
      e.clientY < window.innerHeight
    ) {
      evaluate(e.clientX, e.clientY)
    }
  }
  const onBlur = (): void => {
    pointerHeld = false // 兜底：抬起事件丢失（窗口失焦）时不卡在"按住"状态
  }

  // YIELDED 态驱动源：主进程轮询推送光标窗口内坐标（此时窗口收不到 pointermove）
  const offPointerPos = bridge.window.onPointerPos?.((pos) => {
    if (disposed || pointerHeld) return
    if (!pos) {
      // 主进程切 YIELDED 时补推 null（状态去重信号）：重置判定缓存——
      // 否则"隐藏/显示等边界后指针恰在实体上"时判定无变化、不上报，主进程收不回接管
      lastSolid = null
      return
    }
    evaluate(pos.x, pos.y)
  })

  window.addEventListener('pointermove', onPointerMove, true)
  window.addEventListener('pointerdown', onPointerDown, true)
  window.addEventListener('pointerup', onPointerRelease, true)
  window.addEventListener('pointercancel', onPointerRelease, true)
  window.addEventListener('blur', onBlur)
  devLog('空气让路：已接线（渲染器支持 hitTest，输入交主进程状态机）')

  return () => {
    disposed = true
    window.removeEventListener('pointermove', onPointerMove, true)
    window.removeEventListener('pointerdown', onPointerDown, true)
    window.removeEventListener('pointerup', onPointerRelease, true)
    window.removeEventListener('pointercancel', onPointerRelease, true)
    window.removeEventListener('blur', onBlur)
    if (trailingTimer) window.clearTimeout(trailingTimer)
    trailingTimer = 0
    trailingPoint = null
    offPointerPos?.()
    if (renderer === r) {
      renderer = null
      active = false
      lastSolid = null
      pointerHeld = false
    }
  }
}
