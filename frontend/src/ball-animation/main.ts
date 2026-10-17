/**
 * 魔法球动画页（ball-animation.html）：Canvas 2D 程序化绘制——零素材，全部代码画出来。
 * **视觉与运动设计整体移植自参考实现（magic-flight）**：核心光球（径向渐变光点）、
 * 星屑尾迹（细→粗、青→白、发光）、抵达爆散（径向粒子 + 收敛光晕 + 扩散环）。
 *
 * 分工（主进程为指挥）：**球的飞行由主进程移动球窗完成**（沿二次贝塞尔拱线逐帧 setBounds），
 * 本页里球固定在窗口中心；尾迹/星屑按"窗口位移的反向"在窗内滑动——
 * 还原"球飞过、身后留下一路星屑"的观感（方向感无需 IPC 指令，screenX/Y 差分即得）。
 *
 * 状态机（由 ball-animation:command 驱动）：
 *   idle →（spawn）原地凝聚显现（光点从无到有 + 微脉动；设置向导 relocate 的起手式）
 *        →（flight）飞行表现（球 + 尾迹 + 星屑）
 *        →（capture-burst / release-burst）爆散表现（420ms，球消失、粒子/光晕/环）
 *        →（flight again，回程/显示段）重新点亮
 *        →（fade-out）整层渐隐（随后主进程隐藏球窗）
 *
 * 注意：窗口为全穿透（主进程 setIgnoreMouseEvents(true)），本页不处理任何鼠标事件。
 */
import { getPetBridge } from '../shared/pet-bridge'
import type { BallAnimationCommand } from '../../electron/ipc/channels'
import { BALL_ANIMATION_VISUAL } from './config'

// ------------------------------------------------------------------ 基础

const canvas = document.getElementById('fx') as HTMLCanvasElement | null
const ctx2d = canvas?.getContext('2d') ?? null

/** 视口尺寸（CSS px）与设备像素比（照参考：DPR 缩放保证清晰；上限 2 防 HiDPI 空转） */
let vw = 360
let vh = 360
let dpr = 1

function resize(): void {
  if (!canvas) return
  dpr = Math.min(window.devicePixelRatio || 1, 2)
  vw = window.innerWidth || 360
  vh = window.innerHeight || 360
  canvas.width = Math.max(1, Math.round(vw * dpr))
  canvas.height = Math.max(1, Math.round(vh * dpr))
}
window.addEventListener('resize', resize)
resize()

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v)
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t
/** 帧步长基准（ms）：参考用固定 1/60 步进，本页按实际帧间隔等比例伸缩（f = dt/16.67） */
const FRAME_MS = 1000 / 60

// ------------------------------------------------------------------ 状态

type Mode = 'idle' | 'spawn' | 'flight' | 'burst' | 'fade'

/** 星屑/爆散粒子（照参考的 Particle 结构；速度单位 = px/帧 @60fps） */
interface Particle {
  x: number
  y: number
  vx: number
  vy: number
  life: number
  max: number
  r: number
  c: string
}

/** 尾迹点（窗口坐标；随窗口位移反向滑动 = 世界固定的轨迹） */
interface TrailPoint {
  x: number
  y: number
}

let mode: Mode = 'idle'
/** 球内是否载着宠物剪影（回程/去程携带） */
let cargo = false
/** 进入当前 mode 的时刻（rAF 时间戳；flight 渐入 / burst 进度用） */
let modeStartTs = 0
/** 凝聚时长（spawn 模式；由主进程经指令下发） */
let spawnDurationMs = 250
/** 爆散开始时刻 */
let burstT0 = 0
/** 淡出开始时刻与时长 */
let fadeStartTs = 0
let fadeDurationMs: number = BALL_ANIMATION_VISUAL.fadeFallbackMs

let trail: TrailPoint[] = []
let parts: Particle[] = []

// 窗口位移监测（screenX/Y 差分，同 glb-model 测速手法；此处用原始位移不复用平滑速度）
let lastPos = { x: 0, y: 0, init: false }

// ------------------------------------------------------------------ 指令

function handleCommand(cmd: BallAnimationCommand): void {
  const now = performance.now()
  switch (cmd.type) {
    case 'reset':
      mode = 'idle'
      cargo = false
      trail = []
      parts = []
      break
    case 'flight':
      mode = 'flight'
      cargo = cmd.cargo
      modeStartTs = now
      break
    case 'spawn':
      // 原地凝聚显现（设置向导 relocate 的起手式）：光点从无到有 + 微脉动；
      // 时长由主进程计时（到点发 capture-burst），渲染侧只按跨度做渐入曲线
      mode = 'spawn'
      modeStartTs = now
      spawnDurationMs = Math.max(1, cmd.durationMs)
      break
    case 'capture-burst':
      // 抵达爆散（捕获与释放共用同一套视觉；holdMs 由主进程计时——到点会发下一条指令，
      // 渲染侧无需自行计时）
      mode = 'burst'
      modeStartTs = now
      burstT0 = now
      spawnBurst()
      break
    case 'release-burst':
      mode = 'burst'
      modeStartTs = now
      burstT0 = now
      spawnBurst()
      break
    case 'fade-out':
      mode = 'fade'
      fadeStartTs = now
      fadeDurationMs = Math.max(1, cmd.durationMs)
      break
  }
}

/** 撒一颗星屑（照参考：随机方向速度 + vy 轻微下坠） */
function spawnDust(x: number, y: number): void {
  const cfg = BALL_ANIMATION_VISUAL.dust
  const a = Math.random() * Math.PI * 2
  const sp = Math.random() * cfg.spawnSpeed
  parts.push({
    x: x + (Math.random() - 0.5) * cfg.spawnSpread,
    y: y + (Math.random() - 0.5) * cfg.spawnSpread,
    vx: Math.cos(a) * sp,
    vy: Math.sin(a) * sp + cfg.gravity,
    life: 0,
    max: lerp(cfg.lifeS[0], cfg.lifeS[1], Math.random()),
    r: lerp(cfg.radius[0], cfg.radius[1], Math.random()),
    c: BALL_ANIMATION_VISUAL.colors[(Math.random() * BALL_ANIMATION_VISUAL.colors.length) | 0]
  })
}

/** 抵达爆散（照参考）：30 颗径向粒子（角度均分 + 抖动） */
function spawnBurst(): void {
  const cfg = BALL_ANIMATION_VISUAL.burst
  const cx = vw / 2
  const cy = vh / 2
  for (let i = 0; i < cfg.particles; i++) {
    const a = (i / cfg.particles) * Math.PI * 2 + Math.random() * 0.3
    const sp = lerp(cfg.speed[0], cfg.speed[1], Math.random())
    parts.push({
      x: cx,
      y: cy,
      vx: Math.cos(a) * sp,
      vy: Math.sin(a) * sp,
      life: 0,
      max: lerp(cfg.lifeS[0], cfg.lifeS[1], Math.random()),
      r: lerp(cfg.radius[0], cfg.radius[1], Math.random()),
      c: BALL_ANIMATION_VISUAL.colors[(Math.random() * BALL_ANIMATION_VISUAL.colors.length) | 0]
    })
  }
}

// ------------------------------------------------------------------ 每帧推进

/** 窗口本帧位移（px；尾迹/粒子按反向平移 = 世界固定） */
function measureShift(): { dx: number; dy: number } {
  const x = window.screenX
  const y = window.screenY
  let dx = 0
  let dy = 0
  if (lastPos.init) {
    dx = x - lastPos.x
    dy = y - lastPos.y
  }
  lastPos = { x, y, init: true }
  return { dx, dy }
}

function update(f: number, shift: { dx: number; dy: number }): void {
  const cx = vw / 2
  const cy = vh / 2

  // 世界固定的内容：按窗口位移反向滑动
  for (const p of trail) {
    p.x -= shift.dx
    p.y -= shift.dy
  }
  for (const p of parts) {
    p.x -= shift.dx
    p.y -= shift.dy
  }

  if (mode === 'flight') {
    // 尾迹：每帧在当前球位置（窗心）压入新点；裁剪到点数上限与最大跨度（球窗内的紧凑化）
    trail.push({ x: cx, y: cy })
    while (trail.length > BALL_ANIMATION_VISUAL.trail.maxPoints) trail.shift()
    while (trail.length > 1) {
      const d = Math.hypot(trail[0].x - cx, trail[0].y - cy)
      if (d > BALL_ANIMATION_VISUAL.trail.maxSpanPx) trail.shift()
      else break
    }
    // 星屑：飞行中每帧撒 3 颗
    for (let i = 0; i < BALL_ANIMATION_VISUAL.dust.spawnPerFrame; i++) spawnDust(cx, cy)
  } else if (trail.length > 0) {
    // 非飞行：尾迹快速消散（每帧丢最老一点）
    trail.shift()
  }

  // 粒子推进（照参考：阻尼 0.98/帧、寿命回收；越界留 30px 余量后淘汰）
  const damp = Math.pow(BALL_ANIMATION_VISUAL.dust.damping, f)
  const dtS = (f * FRAME_MS) / 1000
  parts = parts.filter((p) => {
    p.life += dtS
    p.x += p.vx * f
    p.y += p.vy * f
    p.vx *= damp
    p.vy *= damp
    if (p.life >= p.max) return false
    const margin = 30
    return p.x > -margin && p.x < vw + margin && p.y > -margin && p.y < vh + margin
  })
}

// ------------------------------------------------------------------ 绘制

/** 核心光球（照参考：白色→青色的径向渐变光点）+ 外圈紫色柔光；alpha 用于渐入 */
function drawBall(cx: number, cy: number, r: number, alpha: number): void {
  if (alpha <= 0.01) return
  ctx2d!.globalCompositeOperation = 'lighter'

  // 外圈紫晕（魔法紫的"底"，与参考色池同系）
  const halo = ctx2d!.createRadialGradient(cx, cy, r * 0.4, cx, cy, BALL_ANIMATION_VISUAL.haloRadius)
  halo.addColorStop(0, `rgba(167,139,250,${0.3 * alpha})`)
  halo.addColorStop(1, 'rgba(167,139,250,0)')
  ctx2d!.fillStyle = halo
  ctx2d!.beginPath()
  ctx2d!.arc(cx, cy, BALL_ANIMATION_VISUAL.haloRadius, 0, Math.PI * 2)
  ctx2d!.fill()

  // 核心光点（照参考的 17px 渐变：白 → #7dd3fc 0.9 → 透明）
  const g = ctx2d!.createRadialGradient(cx, cy, 0, cx, cy, r)
  g.addColorStop(0, `rgba(255,255,255,${alpha})`)
  g.addColorStop(0.35, `rgba(125,211,252,${0.9 * alpha})`)
  g.addColorStop(1, 'rgba(125,211,252,0)')
  ctx2d!.fillStyle = g
  ctx2d!.beginPath()
  ctx2d!.arc(cx, cy, r, 0, Math.PI * 2)
  ctx2d!.fill()

  ctx2d!.globalCompositeOperation = 'source-over'
}

/** 载宠剪影：球内半透明小动物（圆头 + 双耳），轻微摇摆 = 被拎着的挣扎感 */
function drawCargo(cx: number, cy: number, r: number, now: number): void {
  const tS = now / 1000
  const wob = Math.sin(tS * 6.2) * 0.14
  ctx2d!.save()
  ctx2d!.translate(cx, cy)
  ctx2d!.rotate(wob)
  ctx2d!.fillStyle = 'rgba(255,255,255,0.85)'
  ctx2d!.beginPath()
  ctx2d!.ellipse(0, r * 0.16, r * 0.36, r * 0.31, 0, 0, Math.PI * 2)
  ctx2d!.fill()
  ctx2d!.save()
  ctx2d!.translate(-r * 0.16, -r * 0.16)
  ctx2d!.rotate(-0.18 + wob * 0.5)
  ctx2d!.beginPath()
  ctx2d!.ellipse(0, -r * 0.32, r * 0.1, r * 0.24, 0, 0, Math.PI * 2)
  ctx2d!.fill()
  ctx2d!.restore()
  ctx2d!.save()
  ctx2d!.translate(r * 0.16, -r * 0.16)
  ctx2d!.rotate(0.18 - wob * 0.5)
  ctx2d!.beginPath()
  ctx2d!.ellipse(0, -r * 0.32, r * 0.1, r * 0.24, 0, 0, Math.PI * 2)
  ctx2d!.fill()
  ctx2d!.restore()
  ctx2d!.restore()
}

/** 尾迹线（照参考：由细到粗 0.6→4.2、青色→白色（后 28%）、shadowBlur 发光，越新越亮） */
function drawTrail(): void {
  const cfg = BALL_ANIMATION_VISUAL.trail
  if (trail.length < 2) return
  ctx2d!.save()
  ctx2d!.lineCap = 'round'
  ctx2d!.shadowColor = cfg.shadowColor
  ctx2d!.shadowBlur = cfg.shadowBlur
  for (let i = 1; i < trail.length; i++) {
    const a = i / (trail.length - 1)
    const p0 = trail[i - 1]
    const p1 = trail[i]
    ctx2d!.strokeStyle =
      a > cfg.whiteAt
        ? `rgba(255,255,255,${(a * 0.92).toFixed(3)})`
        : `rgba(125,211,252,${(a * 0.85).toFixed(3)})`
    ctx2d!.lineWidth = cfg.widthMin + a * (cfg.widthMax - cfg.widthMin)
    ctx2d!.beginPath()
    ctx2d!.moveTo(p0.x, p0.y)
    ctx2d!.lineTo(p1.x, p1.y)
    ctx2d!.stroke()
  }
  ctx2d!.restore()
}

/** 星屑/爆散粒子（照参考：alpha 随寿命线性衰减、半径随存活比例缩） */
function drawParticles(baseAlpha: number): void {
  for (const p of parts) {
    const a = Math.max(0, 1 - p.life / p.max)
    ctx2d!.globalAlpha = baseAlpha * a * 0.9
    ctx2d!.fillStyle = p.c
    ctx2d!.beginPath()
    ctx2d!.arc(p.x, p.y, p.r * (0.5 + a * 0.5), 0, Math.PI * 2)
    ctx2d!.fill()
  }
  ctx2d!.globalAlpha = baseAlpha
}

/** 抵达爆散（照参考）：收敛光晕（白→紫渐隐、半径收缩）+ 扩散环（6→32px 描边渐隐） */
function drawBurst(cx: number, cy: number, now: number): void {
  const cfg = BALL_ANIMATION_VISUAL.burst
  const b = clamp01((now - burstT0) / cfg.durationMs)
  // 收敛光晕
  const rad = Math.max(1, cfg.haloRadius * (1 - b * cfg.haloShrink))
  const g = ctx2d!.createRadialGradient(cx, cy, 0, cx, cy, rad)
  g.addColorStop(0, `rgba(255,255,255,${(0.9 * (1 - b)).toFixed(3)})`)
  g.addColorStop(0.5, `rgba(167,139,250,${(0.5 * (1 - b)).toFixed(3)})`)
  g.addColorStop(1, 'rgba(167,139,250,0)')
  ctx2d!.fillStyle = g
  ctx2d!.beginPath()
  ctx2d!.arc(cx, cy, rad, 0, Math.PI * 2)
  ctx2d!.fill()
  // 扩散环
  ctx2d!.strokeStyle = `rgba(167,139,250,${(0.7 * (1 - b)).toFixed(3)})`
  ctx2d!.lineWidth = 2 * (1 - b) + 0.5
  ctx2d!.beginPath()
  ctx2d!.arc(cx, cy, cfg.ringStart + b * cfg.ringSpan, 0, Math.PI * 2)
  ctx2d!.stroke()
}

function draw(now: number): void {
  if (!ctx2d) return
  ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx2d.clearRect(0, 0, vw, vh)

  // 整层 alpha（淡出）
  let globalAlpha = 1
  if (mode === 'fade') globalAlpha = 1 - clamp01((now - fadeStartTs) / fadeDurationMs)
  if (globalAlpha <= 0.002) return
  ctx2d.globalAlpha = globalAlpha

  const cx = vw / 2
  const cy = vh / 2

  // ① 尾迹线（仅飞行中；照参考 f<1 时才画）
  if (mode === 'flight') drawTrail()

  // ② 星屑/爆散粒子
  drawParticles(globalAlpha)

  // ③ 球体 / 凝聚显现 / 抵达爆散
  if (mode === 'flight') {
    // 渐入（约 140ms），防指令到达瞬间"生硬出现"
    const appear = clamp01((now - modeStartTs) / 140)
    const r = BALL_ANIMATION_VISUAL.ballRadius * (cargo ? BALL_ANIMATION_VISUAL.cargoBallScale : 1)
    drawBall(cx, cy, r, appear)
    if (cargo) drawCargo(cx, cy, r, now)
  } else if (mode === 'spawn') {
    // 原地凝聚显现：alpha 从无到有（easeOut）+ 半径轻微"呼吸"脉动（观感=光点凝聚成形）
    const p = clamp01((now - modeStartTs) / spawnDurationMs)
    const eased = 1 - Math.pow(1 - p, 3)
    const pulse = 1 + 0.07 * Math.sin((now - modeStartTs) / 48) * p
    drawBall(cx, cy, BALL_ANIMATION_VISUAL.ballRadius * (0.72 + 0.28 * eased) * pulse, eased)
  } else if (mode === 'burst') {
    drawBurst(cx, cy, now)
  }

  ctx2d.globalAlpha = 1
}

// ------------------------------------------------------------------ 主循环

let lastTs: number | null = null

function tick(ts: number): void {
  requestAnimationFrame(tick)
  if (lastTs === null) {
    lastTs = ts
    measureShift() // 首帧只记录窗口位置基准
    return
  }
  const dtMs = Math.min(64, ts - lastTs)
  lastTs = ts
  const f = dtMs / FRAME_MS // 帧步长系数（参考的固定步进语义按实际帧率伸缩）
  const shift = measureShift()
  update(f, shift)
  draw(ts)
}

// ------------------------------------------------------------------ 接线

getPetBridge().ballAnimation.onCommand(handleCommand)
getPetBridge().ballAnimation.ready()
requestAnimationFrame(tick)

console.log('[ball-animation] 动画页已就绪')
