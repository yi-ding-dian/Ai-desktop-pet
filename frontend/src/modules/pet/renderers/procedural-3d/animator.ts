/**
 * 3D 动画驱动（**只算数，不碰场景**——Three.js 对象的写入在 index.ts 的 applyFrame
 * 与各模型的 applyExtras）。
 *
 * 每帧 update(dt) 输出一个 PetFrame3D（全部可渲染数值，世界单位/弧度），合成顺序：
 *   ① 目标姿态（情绪 × 强度，叠加状态修饰） ← setEmotion/setState 时重算
 *   ② 平滑趋近（指数缓动，帧率无关：k = 1 - e^(-dt/τ)；脸部快 τ=0.12s、身体慢 τ=0.35s）
 *   ③ 程序化微行为：呼吸（squash & stretch 果冻感）、待机摇摆、随机眨眼（2–6s 含连眨）、
 *      **兔耳常驻轻晃 + 随机耳抖（4–9s 一次）**、走路（企鹅 = 碎步/兔子 = 蹦跳）…
 *   ④ 即时反应叠加（摸头：笑眼 + 脸红 + 抖动 + **双耳快速抖动** + 弹跳弹簧 + 心形粒子；
 *      张望：头部左右扫视 + 视线扫）
 *
 * 多模型（2026-10-14 兔子上线）：animator 构造时接收模型的度量（metrics）、情绪姿态表
 * （poses = 企鹅表 / 兔子表）与走路风格（walkStyle）——**帧输出为超集**，
 * 模型不消费的字段（如企鹅忽略 earL/earR、兔子忽略 hairBend）在 applyExtras 里直接忽略。
 * 兔耳姿态在本文件换算为语义量（lift/splay/back/fold），模型侧再换算成骨架旋转。
 *
 * 可爱优先落实：全部运动偏"Q 弹果冻"——弹跳伴随拉长/压缩（squash & stretch），
 * 兔子走路是"小跳步"（一次一跳 + 耳朵弹动，不是企鹅式摇摆），歪头/眨眼/耳动是常驻萌点。
 *
 * 口型策略：外部 setMouth 有值优先；state=speaking 且无外部驱动时用内置振荡兜底
 * （"模拟说话"）。
 */
import type { PetState } from '../../../../shared/protocol'
import type { PetReactionKind } from '../types'
import type { PetModelMetrics3D, WalkStyle3D } from './config'
import { EMOTION_POSES, NEUTRAL_POSE, resolveEmotionPose, type PetPose3D } from './emotion-map'
import type { Emotion } from '../../../../shared/protocol'

// ------------------------------------------------------------------ 常量与工具

/** 指数缓动时间常数（秒）：数值越大越慢 */
const FAST_TAU = 0.12 // 五官（眼/嘴/视线/头/耳姿态）
const SLOW_TAU = 0.35 // 身体（倾斜/翅膀/呆毛/位移/腮红/色偏）
/** 使用慢缓动的字段 */
const SLOW_KEYS: ReadonlySet<string> = new Set([
  'bodyTilt',
  'wingAngle',
  'hairBend',
  'restOffsetY',
  'blush',
  'tintAlpha',
  'headTilt',
  'headPitch',
  'headYaw'
])

/** 数值字段清单（从基线姿态提取，新增字段自动纳入平滑） */
const NUMERIC_KEYS = (Object.keys(NEUTRAL_POSE) as Array<keyof PetPose3D>).filter(
  (k) => typeof NEUTRAL_POSE[k] === 'number'
)

const BLINK_DURATION = 0.16 // 一次眨眼总时长（秒）
const PET_REACTION_DURATION = 0.9 // 摸头反应时长（秒）
const LOOK_AROUND_DURATION = 2.8 // 张望反应时长（秒；执行器按此循环播放以覆盖行为 duration）
const HEART_DURATION_MS = 1100 // 单颗心形粒子飘出时长
const deg = (d: number): number => (d * Math.PI) / 180

// 弹跳弹簧（欠阻尼，Q 弹）：峰值位移 ≈ v0/ω
const SPRING_K = 60 // 劲度（ω = √k ≈ 7.75）
const SPRING_C = 7 // 阻尼
const PET_SPRING_V0 = -1.35 // 摸头弹跳初速（世界单位/秒，负 = 向上；峰值约 0.17）

// 走路参数
const WALK_STEP_PERIOD = 0.42 // 一步周期（秒）；企鹅碎步 / 兔子一次小跳均用此节奏
const WALK_BOB_AMPLITUDE = 0.03 // 企鹅：碎步颠高度（世界单位，小幅度）
const HOP_BOB_AMPLITUDE = 0.055 // 兔子：蹦跳高度（更弹）
const HOP_STRETCH = 0.045 // 兔子：一跳一个 squash & stretch 循环的幅度

// 兔耳微行为
const EAR_FLICK_DURATION = 0.5 // 一次随机耳抖时长（秒）
const EAR_FLICK_AMP = 0.15 // 耳抖摆动幅度（弧度）

// 拟人步态（v3：站立双腿交替行走，弃用蹦跳）
const STRIDE_PX = 90 // 每步窗口前进像素（步幅）——窗口 400px 宽、角色屏幕高 ~190px 的合理步幅
const WALK_RATE_MIN = 0.9 // 步频下限（步/秒；慢速/误差时也保持自然迈步）
const WALK_RATE_MAX = 3.2 // 步频上限（步/秒；避免快速拖动窗口时"原地踏步"）
const WALK_LEG_SWING = 0.62 // 腿前后摆最大角（弧度）
const WALK_ARM_SWING = 0.36 // 手臂反相摆幅（弧度）
const WALK_BOB_HUMAN = 0.024 // 拟人走路每步一次的下沉幅度（世界单位，小幅度）

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v)
const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v)
/** 平滑阶跃（用于反应包络过渡） */
const smoothstep = (x: number): number => {
  const t = clamp01(x)
  return t * t * (3 - 2 * t)
}

// ------------------------------------------------------------------ 帧输出类型

/** 一颗心形粒子的本帧状态（null 表示未激活） */
export interface Heart3DFrame {
  opacity: number
  /** 相对锚点的偏移（世界单位） */
  x: number
  y: number
  z: number
  scale: number
  /** 绕 z 轴旋转（弧度） */
  rotZ: number
}

/**
 * 单只兔耳的本帧语义姿态（模型侧换算成骨架旋转/缩放）。
 * lift/splay/back 已含微行为（轻晃/耳抖/蹦跳弹动），模型直接消费即可。
 */
export interface EarFrame3D {
  /** 竖起度 0–1（0 = 完全垂下、1 = 竖直；>1 = 猛竖拉长） */
  lift: number
  /** 外张附加（弧度；正 = 向外、负 = 内收） */
  splay: number
  /** 前后摆附加（弧度；**正 = 向后压/后飘**、负 = 向前） */
  back: number
  /** 耳尖内折 0–1 */
  fold: number
}

/** 每帧渲染姿态（applyFrame 的输入；世界单位/弧度/0–1 归一量） */
export interface PetFrame3D {
  /** 弹跳/静息垂直偏移（世界单位；正上负下） */
  offsetY: number
  /** 呼吸 squash & stretch（绕脚底缩放；呼吸 + 弹跳/蹦跳拉伸复合） */
  scaleX: number
  scaleY: number
  scaleZ: number
  /** 身体倾斜（弧度，绕脚底轴心，z 轴） */
  bodyTilt: number
  /** 身体偏转（弧度，y 轴；走路时小幅左右扭） */
  bodyYaw: number
  /** 身体前倾（弧度，x 轴；兔子蹦跳前倾用；企鹅恒 0） */
  bodyPitch: number
  /** 头部姿态（弧度，相对身体；头组原点 = 头中心） */
  headTilt: number
  headPitch: number
  headYaw: number
  /** 眼睛 */
  eyeRound: number
  eyeArc: number
  /** 眼睛纵向开度（含眨眼；1 = 常态） */
  eyeOpen: number
  /** 瞳孔偏移（世界单位）与缩放 */
  pupilX: number
  pupilY: number
  pupilScale: number
  browAngry: number
  browSad: number
  /** 嘴（上片俯仰 + 下片开合） */
  mouthOpen: number
  /** 上片俯仰附加（弧度；正 = 上翘） */
  beakLift: number
  /** 脸 */
  blushAlpha: number
  blushColor: string
  /** 翅膀/小手：展开角（弧度，z 轴）+ 前后摆（弧度，x 轴，走路用） */
  wingAngle: number
  wingSwing: number
  /** 呆毛弯曲（弧度；企鹅专属，兔子忽略） */
  hairBend: number
  /** 兔耳姿态（超集字段；企鹅忽略） */
  earL: EarFrame3D
  earR: EarFrame3D
  /** 双耳抖动附加小角（摸头/随机抖；弧度；模型叠加到耳旋转上） */
  earShake: number
  /** 尾巴摇摆（弧度；兔子小圆尾，企鹅忽略） */
  tailWag: number
  // ---- v3 拟人化（站立行走）----
  /** 双腿摆动角（弧度；正 = 前摆；站立模型消费，企鹅/无腿模型忽略） */
  legL: number
  legR: number
  /** 左右手臂各自的前后摆（弧度；拟人走路与对侧腿同相；企鹅仍消费上面的 wingSwing 同步摆） */
  wingSwingL: number
  wingSwingR: number
  /** 双手合十度 0–1（1 = 胸前合十讨食姿态（idle 静息）、0 = 手自然垂摆（走动/其他状态）） */
  handsTogether: number
  /** 情绪色偏（身体材质插值用） */
  tintColor: string
  tintAlpha: number
  /** 心形粒子（与 metrics.heartAnchors 一一对应） */
  hearts: Array<Heart3DFrame | null>
}

interface ReactionState {
  kind: PetReactionKind
  elapsed: number
  duration: number
}

// ------------------------------------------------------------------ 状态修饰

/**
 * 状态机对目标姿态的修饰（thinking 眼睛上飘 + 歪头 + 一耳微斜、sleeping 闭眼垂耳等）。
 * 作用在"目标"上（而非当前值），因此切换状态同样有平滑过渡。
 * 兔耳字段对企鹅模型无副作用（企鹅情绪表/姿态不含耳朵消费）。
 */
function applyStateModifiers(pose: PetPose3D, state: PetState): PetPose3D {
  switch (state) {
    case 'sleeping':
      pose.eyeOpen = Math.min(pose.eyeOpen, 0.1)
      pose.mouthOpen = Math.max(pose.mouthOpen, 0.12) // 打盹微张嘴
      pose.restOffsetY += 0.018
      pose.headPitch += deg(7) // 低头
      pose.headTilt += deg(-3)
      pose.blush *= 0.8
      pose.earLift = Math.min(pose.earLift ?? 0.55, 0.08) // 垂耳
      pose.earSplay = (pose.earSplay ?? 0) + deg(6)
      return pose
    case 'thinking':
      pose.lookY = Math.min(pose.lookY, -0.45) // 眼睛上飘
      pose.lookX = Math.max(pose.lookX, 0.35)
      pose.eyeOpen = Math.min(pose.eyeOpen, 0.95)
      if (Math.abs(pose.headTilt) < deg(2)) pose.headTilt = deg(7) // 无情绪的歪头
      // 一耳直一耳斜（平态思考）；情绪已给耳朵差异则不覆盖
      if (Math.abs(pose.earLiftDeltaL ?? 0) < 0.15) pose.earLiftDeltaL = 0.34
      if (Math.abs(pose.earLiftDeltaR ?? 0) < 0.15) pose.earLiftDeltaR = -0.3
      pose.earSplay = (pose.earSplay ?? 0) + deg(4)
      return pose
    case 'dragging':
      pose.eyeOpen = Math.min(1.2, pose.eyeOpen + 0.16) // 被拎起来睁大眼
      pose.wingAngle -= deg(20) // 翅膀/双臂张开（像扑腾）
      return pose
    case 'walking':
    case 'speaking':
    case 'idle':
    default:
      return pose
  }
}

// ------------------------------------------------------------------ 动画器

export class PetAnimator3D {
  /** 模型度量（注视范围/心形锚点） */
  private readonly metrics: PetModelMetrics3D
  /** 模型情绪表（企鹅 / 兔子；超集字段缺失即忽略） */
  private readonly poses: Record<Emotion, PetPose3D>
  /** 走路风格（waddle = 企鹅碎步 / hop = 兔子蹦跳） */
  private readonly walkStyle: WalkStyle3D

  /** 当前（平滑后）与目标姿态 */
  private pose: PetPose3D
  private target: PetPose3D

  private emotion = 'neutral'
  private intensity = 1
  private state: PetState = 'idle'
  /** 外部口型值（null = 未驱动） */
  private mouthOverride: number | null = null

  // 微行为相位/计时
  private breathPhase = Math.random() * Math.PI * 2 // 随机初相，避免多实例同步
  private swayPhase = Math.random() * Math.PI * 2
  private hairPhase = Math.random() * Math.PI * 2
  private earPhase = Math.random() * Math.PI * 2
  private mouthPhase = 0
  private walkPhase = 0
  private blinkTimer = 1.5 + Math.random() * 2
  /** 眨眼进度（秒）；<0 = 未在眨 */
  private blinkT = -1
  /** 随机耳抖：距下次触发的秒数 / 当前进度（<0 = 未在抖） */
  private earFlickTimer = 3 + Math.random() * 5
  private earFlickT = -1

  // 弹跳弹簧（欠阻尼：触发一次弹两下）
  private springY = 0
  private springVy = 0

  /** 窗口移动速度（px/s；渲染器外壳每帧喂入）——拟人步态步频来源（见 setLocomotionSpeed） */
  private locomotionSpeed = 0
  /** 双手合十度（平滑值；idle 合十讨食 ↔ 其他状态垂摆） */
  private handsTogether = 1

  private reaction: ReactionState | null = null

  constructor(
    metrics: PetModelMetrics3D,
    poses: Record<Emotion, PetPose3D> = EMOTION_POSES,
    walkStyle: WalkStyle3D = 'waddle'
  ) {
    this.metrics = metrics
    this.poses = poses
    this.walkStyle = walkStyle
    this.pose = { ...NEUTRAL_POSE }
    this.target = resolveEmotionPose('neutral', 1, poses)
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

  /**
   * 喂入窗口实际移动速度（px/s）——拟人步态按"速度 / 步幅"推算步频，
   * 让步子节奏与窗口移动速度匹配（渲染器外壳读 window.screenX/screenY 差分，接口零改动）。
   */
  setLocomotionSpeed(pxPerSec: number): void {
    this.locomotionSpeed = Number.isFinite(pxPerSec) ? Math.max(0, pxPerSec) : 0
  }

  playReaction(kind: PetReactionKind): void {
    if (kind === 'pet') {
      this.reaction = { kind, elapsed: 0, duration: PET_REACTION_DURATION }
      this.springVy += PET_SPRING_V0 // 向上弹一下（Q 弹果冻）
    } else if (kind === 'look_around') {
      this.reaction = { kind, elapsed: 0, duration: LOOK_AROUND_DURATION }
    }
    // captured/released（魔法球捕获/释放，ball-animation 域触发）：本渲染器暂不实现专属表现——
    // 窗口缩放/移动本身已有"被吸走/被放回"的观感（新 kind 静默忽略，向后兼容）
  }

  // ---------------- 每帧推进 ----------------

  update(dtRaw: number): PetFrame3D {
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

    // ② 微行为相位推进（睡着呼吸更慢更深）
    const sleeping = this.state === 'sleeping'
    const breathPeriod = sleeping ? 3.6 : 2.6
    const breathDepth = sleeping ? 1.45 : 1
    this.breathPhase += (dt * Math.PI * 2) / breathPeriod
    this.swayPhase += (dt * Math.PI * 2) / 3.9
    this.hairPhase += (dt * Math.PI * 2) / 1.7
    this.earPhase += (dt * Math.PI * 2) / 2.4
    this.mouthPhase += dt * 11
    // walkPhase 推进在 ⑥ 合成段按走路风格处理（拟人 = 速度驱动步频；企鹅/蹦跳 = 固定周期）

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

    // ③b 随机耳抖调度（4–9s 一次，睡中幅度减小；兔耳"灵魂"微行为）
    if (this.earFlickT >= 0) {
      this.earFlickT += dt
      if (this.earFlickT >= EAR_FLICK_DURATION) {
        this.earFlickT = -1
        this.earFlickTimer = 4 + Math.random() * 5
      }
    } else {
      this.earFlickTimer -= dt
      if (this.earFlickTimer <= 0) this.earFlickT = 0
    }
    const flickP = this.earFlickT < 0 ? 0 : this.earFlickT / EAR_FLICK_DURATION
    // 包络（0→1→0）× 快速振荡（约 2.5 个来回）
    const earFlick =
      this.earFlickT < 0 ? 0 : Math.sin(flickP * Math.PI) * Math.sin(flickP * Math.PI * 5) * EAR_FLICK_AMP * (sleeping ? 0.4 : 1)

    // ④ 弹跳弹簧（半隐式欧拉；欠阻尼）
    this.springVy += (-SPRING_K * this.springY - SPRING_C * this.springVy) * dt
    this.springY += this.springVy * dt

    // ⑤ 即时反应：摸头（包络 + 心形粒子 + 双耳快速抖动）/ 张望（头部与视线左右扫）
    let reactEnv = 0
    let lookAroundEnv = 0
    let lookAroundSweep = 0
    const hearts: Array<Heart3DFrame | null> = this.metrics.heartAnchors.map(() => null)
    if (this.reaction) {
      this.reaction.elapsed += dt
      const p = this.reaction.elapsed / this.reaction.duration
      if (p >= 1) {
        this.reaction = null
      } else if (this.reaction.kind === 'pet') {
        const RISE = 0.12
        const FALL = 0.35
        const env = p < RISE ? p / RISE : p > 1 - FALL ? (1 - p) / FALL : 1
        reactEnv = smoothstep(env)
        for (let i = 0; i < hearts.length; i++) {
          hearts[i] = this.computeHeart(i, this.reaction.elapsed * 1000)
        }
      } else if (this.reaction.kind === 'look_around') {
        const FADE = 0.15
        const env = p < FADE ? p / FADE : p > 1 - FADE ? (1 - p) / FADE : 1
        lookAroundEnv = smoothstep(env)
        lookAroundSweep = Math.sin(p * Math.PI * 4) // 两个来回的扫视
      }
    }

    // ⑥ 合成输出
    const p = this.pose
    const breath = Math.sin(this.breathPhase) * breathDepth
    const swayAmpDeg = this.state === 'idle' ? 2.4 : sleeping ? 1.2 : this.state === 'speaking' ? 1.4 : 1.8
    const sway = deg(Math.sin(this.swayPhase) * swayAmpDeg)

    // 走路：三种风格——
    //   waddle（企鹅小碎步）/ hop（v2 蹦跳）→ 固定周期相位；
    //   human（v3 拟人）：步频 = 窗口移动速度 / 步幅（速度驱动，节奏与窗口移动匹配）
    const walking = this.state === 'walking'
    const style = this.walkStyle
    const hop = style === 'hop'
    const human = style === 'human'
    if (walking) {
      if (human) {
        const rate = clamp(this.locomotionSpeed / STRIDE_PX, WALK_RATE_MIN, WALK_RATE_MAX)
        this.walkPhase += dt * rate * Math.PI * 2
      } else {
        this.walkPhase += (dt * Math.PI * 2) / WALK_STEP_PERIOD
      }
    }
    const walkSin = Math.sin(this.walkPhase)
    const walkWave = Math.abs(walkSin)
    const walkBob = walking ? -walkWave * (hop ? HOP_BOB_AMPLITUDE : human ? WALK_BOB_HUMAN : WALK_BOB_AMPLITUDE) : 0
    // 蹦跳：一跳一个 squash & stretch 循环（起跳拉长、下落压扁；与弹跳高度同频）
    const hopStretch = walking && hop ? Math.sin(this.walkPhase * 2) * HOP_STRETCH : 0
    const hopPitch = walking && hop ? 0.06 + 0.03 * walkSin : 0
    const rockScale = hop ? 0.45 : 1
    const walkRock = walking ? deg(human ? 2.2 : 2.6) * rockScale * walkSin : 0
    const walkYaw = walking ? 0.07 * rockScale * walkSin : 0
    const wingSwingBase = walking ? walkSin * (hop ? 0.5 : 0.34) : 0
    // 拟人步态：双腿交替迈步（反相）+ 双臂与对侧腿同相（自然摆臂）
    const legL = walking && human ? walkSin * WALK_LEG_SWING : 0
    const legR = walking && human ? -walkSin * WALK_LEG_SWING : 0
    const wingSwingL = walking && human ? -walkSin * WALK_ARM_SWING : wingSwingBase
    const wingSwingR = walking && human ? walkSin * WALK_ARM_SWING : wingSwingBase
    // 拟人身体前倾（走路微前倾 + 随步轻点）与头部随步微点（保持稳定）
    const humanPitch = walking && human ? 0.05 + 0.015 * Math.sin(this.walkPhase * 2) : 0
    const humanHeadNod = walking && human ? Math.sin(this.walkPhase * 2) * deg(1.2) : 0
    // 双手合十：idle 静息合十讨食、走动/其他状态自然垂摆（平滑切换）
    const handsTarget = this.state === 'idle' ? 1 : 0
    this.handsTogether += (handsTarget - this.handsTogether) * (1 - Math.exp(-dt / 0.3))

    // 摸头反应叠加（笑眼替换圆眼、脸红、开心抖动、呆毛甩动、双耳快速抖动）
    const reactSway = reactEnv > 0.01 ? deg(1.6) * Math.sin(this.reaction!.elapsed * 13) * reactEnv : 0
    const eyeArc = clamp01(p.eyeArc + 0.9 * reactEnv)
    const eyeRound = clamp01(p.eyeRound - 0.9 * reactEnv)
    const blush = clamp01(p.blush + 0.3 * reactEnv)
    const hairBend = p.hairBend - deg(12) * reactEnv + deg(2.2) * Math.sin(this.hairPhase) * (1 - reactEnv)
    const earShake = reactEnv > 0.01 ? Math.sin(this.reaction!.elapsed * 46) * 0.26 * reactEnv : 0

    // 眼睛最终开度（眨眼 × 基础开度）
    const lidScale = clamp((1 - 0.94 * blink) * p.eyeOpen, 0.03, 1.3)

    // 口型：外部驱动优先；speaking 无外部驱动时内置振荡兜底
    let mouthOpen = p.mouthOpen
    if (this.state === 'speaking') {
      const autoOsc = 0.3 + 0.5 * (0.5 + 0.5 * Math.sin(this.mouthPhase))
      mouthOpen = this.mouthOverride != null ? this.mouthOverride : autoOsc
    } else if (this.mouthOverride != null) {
      mouthOpen = Math.max(mouthOpen, this.mouthOverride) // 调试按键：任何状态可张嘴
    }

    // 翅膀/双臂：呼吸带动微摆 + 反应展开 + 走路节奏
    const wingAngle = p.wingAngle + deg(1.4) * Math.sin(this.breathPhase * 0.5) - deg(12) * reactEnv + walkRock * 0.8

    // 张望叠加：头部左右转向 + 视线扫（look_around 行为期间）
    const lookX = clamp(p.lookX + 0.7 * lookAroundSweep * lookAroundEnv, -1, 1)
    const headYaw = p.headYaw + 0.42 * lookAroundSweep * lookAroundEnv

    // 兔耳合成：常驻轻晃 + 随机耳抖 + 蹦跳弹动 + 拖拽后飘（企鹅模型不消费，忽略）
    const earIdleAmp = sleeping ? 0.02 : 0.045
    const earSway = Math.sin(this.earPhase) * earIdleAmp
    const dragging = this.state === 'dragging'
    const dragBack = dragging ? 0.5 + Math.sin(this.swayPhase * 2.4) * 0.1 : 0
    const hopFlop = walking && hop ? Math.sin(this.walkPhase - 0.9) * 0.3 : 0
    const walkEarFlop = walking && human ? Math.sin(this.walkPhase - 0.7) * 0.07 : 0
    const earLiftBase = p.earLift ?? 0.55
    const earL: EarFrame3D = {
      lift: clamp(earLiftBase + (p.earLiftDeltaL ?? 0), 0, 1.15),
      splay: (p.earSplay ?? 0) + earFlick * 0.5,
      back: (p.earBack ?? 0) + earSway + earFlick + dragBack + hopFlop + walkEarFlop,
      fold: p.earFold ?? 0
    }
    const earR: EarFrame3D = {
      lift: clamp(earLiftBase + (p.earLiftDeltaR ?? 0), 0, 1.15),
      splay: (p.earSplay ?? 0) + earFlick * 0.5,
      back: (p.earBack ?? 0) + earSway + earFlick + dragBack + hopFlop + walkEarFlop,
      fold: p.earFold ?? 0
    }
    // 尾巴：情绪 + 常驻轻摆（睡着不摆）
    const tailWag = (p.tailWag ?? 0) + (sleeping ? 0 : Math.sin(this.swayPhase * 0.8) * 0.06)

    // squash & stretch：呼吸（体积近似守恒）+ 弹跳速度拉伸 + 蹦跳循环（果冻感）
    const springStretch = clamp(-this.springVy * 0.045, -0.09, 0.09)
    const totalStretch = springStretch + hopStretch
    const scaleY = (1 + 0.030 * breath) * (1 + totalStretch)
    const scaleXZ = (1 - 0.020 * breath) * (1 - totalStretch * 0.55)

    const lookRange = this.metrics.eyeLookRange

    return {
      offsetY: p.restOffsetY + this.springY + walkBob,
      scaleX: scaleXZ,
      scaleY,
      scaleZ: scaleXZ,
      bodyTilt: p.bodyTilt + sway + reactSway + walkRock,
      bodyYaw: walkYaw,
      bodyPitch: hopPitch + humanPitch,
      headTilt: p.headTilt,
      headPitch: p.headPitch + humanHeadNod,
      headYaw,
      eyeRound,
      eyeArc,
      eyeOpen: lidScale,
      pupilX: lookX * lookRange.x,
      pupilY: p.lookY * lookRange.y,
      pupilScale: p.pupilScale,
      browAngry: p.browAngry,
      browSad: p.browSad,
      mouthOpen: clamp01(mouthOpen),
      beakLift: p.beakLift,
      blushAlpha: blush,
      blushColor: p.blushColor,
      wingAngle,
      wingSwing: wingSwingBase,
      wingSwingL,
      wingSwingR,
      hairBend,
      earL,
      earR,
      earShake,
      tailWag,
      legL,
      legR,
      handsTogether: this.handsTogether,
      tintColor: p.tintColor,
      tintAlpha: p.tintAlpha,
      hearts
    }
  }

  // ---------------- 内部 ----------------

  private recomputeTarget(): void {
    const base = resolveEmotionPose(this.emotion, this.intensity, this.poses)
    // 注意：resolveEmotionPose 可能返回常量表引用，必须先浅拷贝再修饰
    this.target = applyStateModifiers({ ...base }, this.state)
  }

  /** 计算第 i 颗心形粒子本帧状态（延迟错开、上浮、左右摆、放大、轻旋） */
  private computeHeart(index: number, elapsedMs: number): Heart3DFrame | null {
    const a = this.metrics.heartAnchors[index]
    const p = (elapsedMs - a.delayMs) / HEART_DURATION_MS
    if (p < 0 || p >= 1) return null
    const ease = 1 - (1 - p) * (1 - p)
    const opacity = p < 0.15 ? p / 0.15 : p > 0.55 ? (1 - p) / 0.45 : 1
    return {
      opacity: clamp01(opacity) * 0.95,
      x: a.sway * Math.sin(p * Math.PI * 2.2),
      y: 0.45 * ease, // 向上飘出（上限控制在画布可见范围内）
      z: 0.08 * Math.sin(p * Math.PI * 1.4),
      scale: 0.5 + 0.6 * ease,
      rotZ: 2.2 * a.sway * Math.sin(p * Math.PI * 1.6) // 轻旋（a.sway≈0.1 → 约 ±12°）
    }
  }
}
