/**
 * 部件动画驱动（**只算数，不碰 DOM**——DOM 写入在 index.ts 的 applyFrame）。
 *
 * 每帧 update(dt) 输出一个 PetFrame（全部可渲染数值），合成顺序：
 *   ① 目标姿态（情绪 × 强度，叠加状态修饰） ← setEmotion/setState 时重算
 *   ② 平滑趋近（指数缓动，帧率无关：k = 1 - e^(-dt/τ)；脸部快 τ=0.12s、身体慢 τ=0.35s）
 *   ③ 程序化微行为叠加：呼吸（2.6s 周期）、待机摇摆、随机眨眼（2–6s，含连眨）、走路颠步
 *   ④ 即时反应叠加（摸头：笑眼 + 脸红 + 抖动 + 弹跳弹簧 + 心形粒子）
 *
 * 口型策略：外部 setMouth 有值优先；state=speaking 且无外部驱动时用内置振荡兜底（"模拟说话"）。
 */
import type { PetState } from '../../../../shared/protocol'
import type { PetReactionKind } from '../types'
import { NEUTRAL_POSE, resolveEmotionPose, type PetPose } from './emotion-map'
import type { PenguinConfig } from './config'

// ------------------------------------------------------------------ 常量与工具

/** 指数缓动时间常数（秒）：数值越大越慢 */
const FAST_TAU = 0.12 // 五官（眼/嘴/眉/视线）
const SLOW_TAU = 0.35 // 身体（倾斜/翅膀/呆毛/位移/腮红/色偏）
/** 使用慢缓动的字段 */
const SLOW_KEYS: ReadonlySet<string> = new Set([
  'tilt',
  'wingAngle',
  'hairBend',
  'restOffsetY',
  'blush',
  'tintAlpha'
])

/** 数值字段清单（从基线姿态提取，新增字段自动纳入平滑） */
const NUMERIC_KEYS = (Object.keys(NEUTRAL_POSE) as Array<keyof PetPose>).filter(
  (k) => typeof NEUTRAL_POSE[k] === 'number'
)

const BLINK_DURATION = 0.16 // 一次眨眼总时长（秒）
const PET_REACTION_DURATION = 0.9 // 摸头反应时长（秒）
const HEART_DURATION_MS = 1100 // 单颗心形粒子飘出时长
const BLUSH_MAX_OPACITY = 0.9 // blush=1 时的实际不透明度

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v)
const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v)
/** 平滑阶跃（用于包络过渡） */
const smoothstep = (x: number): number => {
  const t = clamp01(x)
  return t * t * (3 - 2 * t)
}

// ------------------------------------------------------------------ 帧输出类型

/** 一颗心形粒子的本帧状态（null 表示未激活） */
export interface HeartFrame {
  opacity: number
  /** 平移（viewBox 坐标，相对 config 锚点） */
  x: number
  y: number
  scale: number
  rotate: number
}

/** 每帧渲染姿态（applyFrame 的输入；单位：viewBox 坐标/度/0–1 归一化） */
export interface PetFrame {
  /** 呼吸缩放（绕脚底轴心） */
  scaleX: number
  scaleY: number
  /** 倾斜 + 摇摆总角度（度，绕脚底轴心） */
  rotate: number
  /** 垂直偏移（viewBox px；正下负上，含弹跳/静息/颠步） */
  offsetY: number
  /** 眼睛 */
  eyeRound: number
  eyeArc: number
  /** 眼睛纵向压缩（含基础开度与眨眼；1 = 常态） */
  eyelidScale: number
  pupilX: number
  pupilY: number
  pupilScale: number
  browAngry: number
  browSad: number
  /** 嘴（宽度为 viewBox px） */
  mouthWidth: number
  mouthCurve: number
  mouthOpen: number
  /** 脸 */
  blushAlpha: number
  blushColor: string
  /** 身体 */
  wingAngle: number
  hairBend: number
  tintColor: string
  tintAlpha: number
  /** 心形粒子（与 config.hearts.anchors 一一对应） */
  hearts: Array<HeartFrame | null>
}

interface ReactionState {
  kind: PetReactionKind
  elapsed: number
  duration: number
}

// ------------------------------------------------------------------ 状态修饰

/**
 * 状态机对目标姿态的修饰（thinking 眼睛上飘、sleeping 闭眼等）。
 * 作用在"目标"上（而非当前值），因此切换状态同样有平滑过渡。
 */
function applyStateModifiers(pose: PetPose, state: PetState): PetPose {
  switch (state) {
    case 'sleeping':
      pose.eyeOpen = Math.min(pose.eyeOpen, 0.1)
      pose.mouthOpen = Math.max(pose.mouthOpen, 0.14) // 打盹微张嘴
      pose.restOffsetY += 2
      pose.tilt += -3
      pose.blush *= 0.8
      return pose
    case 'thinking':
      pose.lookY = Math.min(pose.lookY, -0.45) // 眼睛上飘
      pose.lookX = Math.max(pose.lookX, 0.35)
      pose.eyeOpen = Math.min(pose.eyeOpen, 0.95)
      if (Math.abs(pose.tilt) < 2) pose.tilt = 6 // 无情绪的歪头
      return pose
    case 'dragging':
      pose.eyeOpen = Math.min(1.18, pose.eyeOpen + 0.15) // 被拎起来睁大眼
      pose.wingAngle -= 18 // 翅膀张开
      return pose
    case 'walking':
    case 'speaking':
    case 'idle':
    default:
      return pose
  }
}

// ------------------------------------------------------------------ 动画器

export class PetAnimator {
  private readonly cfg: PenguinConfig

  /** 当前（平滑后）与目标姿态 */
  private pose: PetPose
  private target: PetPose

  private emotion = 'neutral'
  private intensity = 1
  private state: PetState = 'idle'
  /** 外部口型值（null = 未驱动） */
  private mouthOverride: number | null = null

  // 微行为相位/计时
  private breathPhase = Math.random() * Math.PI * 2 // 随机初相，避免多实例同步
  private swayPhase = Math.random() * Math.PI * 2
  private mouthPhase = 0
  private walkPhase = 0
  private blinkTimer = 1.5 + Math.random() * 2
  /** 眨眼进度（秒）；<0 = 未在眨 */
  private blinkT = -1

  // 弹跳弹簧（欠阻尼：触发一次弹两下）
  private springY = 0
  private springVy = 0

  private reaction: ReactionState | null = null

  constructor(cfg: PenguinConfig) {
    this.cfg = cfg
    this.pose = { ...NEUTRAL_POSE }
    this.target = resolveEmotionPose('neutral', 1)
    this.recomputeTarget()
  }

  // ---------------- 指令接口 ----------------

  setEmotion(emotion: string, intensity = 1): void {
    this.emotion = emotion
    this.intensity = intensity
    this.recomputeTarget()
  }

  setState(state: PetState): void {
    this.state = state
    this.recomputeTarget()
  }

  setMouth(level: number): void {
    this.mouthOverride = clamp01(level)
  }

  playReaction(kind: PetReactionKind): void {
    if (kind !== 'pet') return
    this.reaction = { kind, elapsed: 0, duration: PET_REACTION_DURATION }
    this.springVy -= 240 // 向上弹一下（峰值约 17px）
  }

  // ---------------- 每帧推进 ----------------

  update(dtRaw: number): PetFrame {
    const dt = clamp(dtRaw, 0, 0.06) // 防切后台/掉帧后的跳变

    // ① 姿态平滑（帧率无关指数缓动）
    const poseNum = this.pose as unknown as Record<string, number>
    const tgtNum = this.target as unknown as Record<string, number>
    for (const key of NUMERIC_KEYS) {
      const tau = SLOW_KEYS.has(key) ? SLOW_TAU : FAST_TAU
      poseNum[key] += (tgtNum[key] - poseNum[key]) * (1 - Math.exp(-dt / tau))
    }
    this.pose.blushColor = this.target.blushColor
    this.pose.tintColor = this.target.tintColor

    // ② 微行为相位推进
    const breathPeriod = this.state === 'sleeping' ? 3.6 : 2.6 // 睡着呼吸更慢
    const breathDepth = this.state === 'sleeping' ? 1.45 : 1
    this.breathPhase += (dt * Math.PI * 2) / breathPeriod
    this.swayPhase += (dt * Math.PI * 2) / 3.9
    this.mouthPhase += dt * 11
    this.walkPhase += (dt * Math.PI * 2) / 0.5

    // ③ 随机眨眼调度（2–6s；25% 概率连眨第二下）
    if (this.blinkT >= 0) {
      this.blinkT += dt
      if (this.blinkT >= BLINK_DURATION) {
        this.blinkT = -1
        this.blinkTimer = Math.random() < 0.25 ? 0.14 : 2 + Math.random() * 4
      }
    } else {
      this.blinkTimer -= dt
      if (this.blinkTimer <= 0) this.blinkT = 0
    }
    const blink =
      this.blinkT < 0
        ? 0
        : this.blinkT / BLINK_DURATION < 0.42
          ? smoothstep(this.blinkT / BLINK_DURATION / 0.42)
          : 1 - smoothstep((this.blinkT / BLINK_DURATION - 0.42) / 0.58)

    // ④ 弹跳弹簧（半隐式欧拉；欠阻尼）
    this.springVy += (-180 * this.springY - 11 * this.springVy) * dt
    this.springY += this.springVy * dt

    // ⑤ 摸头反应：包络（快进 → 保持 → 缓出）+ 心形粒子
    let reactEnv = 0
    let hearts: Array<HeartFrame | null> = this.cfg.hearts.anchors.map(() => null)
    if (this.reaction) {
      this.reaction.elapsed += dt
      const p = this.reaction.elapsed / this.reaction.duration
      if (p >= 1) {
        this.reaction = null
      } else {
        const RISE = 0.12
        const FALL = 0.35
        const env = p < RISE ? p / RISE : p > 1 - FALL ? (1 - p) / FALL : 1
        reactEnv = smoothstep(env)
        hearts = this.computeHearts(this.reaction.elapsed * 1000)
      }
    }

    // ⑥ 合成输出
    const p = this.pose
    const breath = Math.sin(this.breathPhase) * breathDepth
    const swayAmp =
      this.state === 'idle'
        ? 2.4
        : this.state === 'sleeping'
          ? 1.2
          : this.state === 'speaking'
            ? 1.4
            : 1.8
    const sway = Math.sin(this.swayPhase) * swayAmp
    const walkBob = this.state === 'walking' ? -Math.abs(Math.sin(this.walkPhase)) * 5 : 0

    // 摸头反应叠加（笑眼替换圆眼、脸红、开心抖动、呆毛甩动）
    const reactSway = reactEnv > 0.01 ? Math.sin(this.reaction!.elapsed * 13) * 2.6 * reactEnv : 0
    const eyeArc = clamp01(p.eyeArc + 0.9 * reactEnv)
    const eyeRound = clamp01(p.eyeRound - 0.9 * reactEnv)
    const blush = clamp01(p.blush + 0.3 * reactEnv)
    const hairBend = p.hairBend - 15 * reactEnv + Math.sin(this.swayPhase * 0.9) * 1.2

    // 眼睛最终开度（眨眼 × 基础开度）
    const lidScale = clamp((1 - 0.94 * blink) * p.eyeOpen, 0.04, 1.25)

    // 口型：外部驱动优先；speaking 无外部驱动时内置振荡兜底
    let mouthOpen = p.mouthOpen
    if (this.state === 'speaking') {
      const autoOsc = 0.3 + 0.5 * (0.5 + 0.5 * Math.sin(this.mouthPhase))
      mouthOpen = this.mouthOverride != null ? this.mouthOverride : autoOsc
    } else if (this.mouthOverride != null) {
      mouthOpen = Math.max(mouthOpen, this.mouthOverride) // 调试按键：任何状态可张嘴
    }

    // 翅膀：呼吸带动微摆 + 反应展开
    const wingAngle = p.wingAngle + Math.sin(this.breathPhase * 0.5) * 1.6 - 14 * reactEnv

    return {
      scaleX: 1 - 0.013 * breath,
      scaleY: 1 + 0.026 * breath,
      rotate: p.tilt + sway + reactSway,
      offsetY: p.restOffsetY + this.springY + walkBob,
      eyeRound,
      eyeArc,
      eyelidScale: lidScale,
      pupilX: p.lookX * 9,
      pupilY: p.lookY * 8,
      pupilScale: p.pupilScale,
      browAngry: p.browAngry,
      browSad: p.browSad,
      mouthWidth: this.cfg.mouth.baseWidth * p.mouthWidth,
      mouthCurve: p.mouthCurve,
      mouthOpen: clamp01(mouthOpen),
      blushAlpha: blush * BLUSH_MAX_OPACITY,
      blushColor: p.blushColor,
      wingAngle,
      hairBend,
      tintColor: p.tintColor,
      tintAlpha: p.tintAlpha,
      hearts
    }
  }

  // ---------------- 内部 ----------------

  private recomputeTarget(): void {
    const base = resolveEmotionPose(this.emotion, this.intensity)
    // 注意：resolveEmotionPose 可能返回常量表引用，必须先浅拷贝再修饰
    this.target = applyStateModifiers({ ...base }, this.state)
  }

  /** 计算心形粒子本帧状态（延迟错开、上飘、左右摆、放大） */
  private computeHearts(elapsedMs: number): Array<HeartFrame | null> {
    return this.cfg.hearts.anchors.map((a) => {
      const p = (elapsedMs - a.delayMs) / HEART_DURATION_MS
      if (p < 0 || p >= 1) return null
      const ease = 1 - (1 - p) * (1 - p)
      const opacity = p < 0.15 ? p / 0.15 : p > 0.55 ? (1 - p) / 0.45 : 1
      return {
        opacity: clamp01(opacity) * 0.95,
        x: a.x + a.swayPx * Math.sin(p * Math.PI * 2.2),
        y: a.y - 70 * ease,
        scale: 0.5 + 0.65 * ease,
        rotate: a.swayPx * 0.5 * Math.sin(p * Math.PI * 1.6)
      }
    })
  }
}
