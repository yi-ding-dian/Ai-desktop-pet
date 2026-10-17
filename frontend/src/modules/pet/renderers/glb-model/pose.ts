/**
 * GLB 模型渲染器（'glb-model'）的姿态层：情绪/状态/移动 → **整体姿态**的纯数据与合成。
 *
 * 背景：Meshy 生成的兔子 GLB 是**单节点静态网格**（无骨骼、无表情、无动画），
 * 因此接口映射只能作用于"整体姿态"（根节点的位移/倾斜/缩放 + 程序化起伏）。
 * 本文件只算数（不碰 three 场景对象），渲染器 index.ts 负责阻尼追踪与逐帧写入。
 *
 * 设计原则（克制、不廉价）：
 * - 所有姿态幅度小（位移 ≤ 0.08 世界单位、倾角 ≤ 0.13 rad），静态目标 + 缓慢阻尼，
 *   避免"整体乱晃"的廉价感；
 * - 动态起伏（弹跳/呼吸/点头/轻晃）**按优先级选一种**而不是叠加多种（避免互相打架）：
 *   摸头反应 > 状态动态（非 idle）> 移动起伏 > 情绪动态（idle 时）；
 * - 静态通道（位移/倾角/缩放）可相加：情绪 + 状态 + 移动前倾都是小量，叠加结果仍然克制。
 *
 * 正负号约定（相机在 +Z 看向模型；模型已校正为面向 +Z = 面向用户）：
 * - pitch 正 = 前倾（低头，顶部朝观察者）；负 = 后仰/抬头；
 * - yaw 正 = 头部转向观察者右侧（模型向左看）；
 * - roll 正 = 向观察者右侧倒（模型自身向左侧倾）。
 * 若后续换模型导致朝向不同，只需调整 index.ts 的模型朝向校正，不改本文件。
 */
import type { Emotion, PetState } from '../../../../shared/protocol'

/** 姿态通道（静态目标值；渲染器对每通道做指数阻尼追踪） */
export interface GlbChannels {
  /** 竖直偏移（世界单位；模型总高 ≈1.0，脚底为 0） */
  offsetY: number
  /** 前倾/低头（弧度） */
  pitch: number
  /** 左右转向（弧度） */
  yaw: number
  /** 侧倾（弧度） */
  roll: number
  /** 整体缩放（1 = 基准；shy 微缩 / surprised 微胀） */
  scale: number
}

/** 起伏种类（同一时刻只播一种） */
export type GlbMotionKind = 'none' | 'bounce' | 'breathe' | 'nod' | 'sway'

/** 动态起伏参数（由渲染器按相位累积求值） */
export interface GlbMotion {
  kind: GlbMotionKind
  /** 幅度（bounce=位移、breathe=位移、nod=pitch、sway=roll） */
  amp: number
  /** 频率（Hz） */
  freq: number
}

/** 完整姿态 = 静态通道 + 动态起伏 + 高频微颤 */
export interface GlbPose {
  channels: GlbChannels
  motion: GlbMotion
  /** 高频微颤幅度（弧度；angry 用，叠加在 pitch/roll 上的快频小抖） */
  quiver: number
}

const ZERO_CHANNELS: GlbChannels = { offsetY: 0, pitch: 0, yaw: 0, roll: 0, scale: 1 }
const NO_MOTION: GlbMotion = { kind: 'none', amp: 0, freq: 0 }

/** 静息微呼吸（基准姿态的"活着感"；幅度极小，只是轻微呼吸起伏） */
const BREATH_CALM: GlbMotion = { kind: 'breathe', amp: 0.006, freq: 0.22 }

/**
 * 情绪姿态表（8 情绪 → 静态目标 + 动态）。
 * 无耳朵/嘴可用，全部靠"整体姿态语言"表达情绪（低头=难过、轻跳=开心、前倾颤抖=生气…）。
 * 幅度取值原则：**静帧可读**（截图对比时 8 情绪能一眼分辨）但不超过 ~0.2 rad / 0.07 世界单位
 * （超出会显得"整体乱倒"而不像情绪）；区分感主要靠方向（上/下、前/后、正/倾）而非幅度。
 */
export const EMOTION_POSES: Record<Emotion, GlbPose> = {
  neutral: {
    channels: { ...ZERO_CHANNELS },
    motion: BREATH_CALM,
    quiver: 0
  },
  happy: {
    // 轻弹跳 + 抬头（喜悦：向上、轻快）
    channels: { ...ZERO_CHANNELS, offsetY: 0.02, pitch: -0.1 },
    motion: { kind: 'bounce', amp: 0.05, freq: 1.9 },
    quiver: 0
  },
  sad: {
    // 低头 + 下沉（沮丧：向下、收敛）
    channels: { ...ZERO_CHANNELS, offsetY: -0.03, pitch: 0.18 },
    motion: { kind: 'breathe', amp: 0.006, freq: 0.16 },
    quiver: 0
  },
  angry: {
    // 前倾 + 高频微颤（生气：蓄势向前、绷紧）
    channels: { ...ZERO_CHANNELS, pitch: 0.14 },
    motion: NO_MOTION,
    quiver: 0.018
  },
  surprised: {
    // 上弹浮起 + 微胀（惊讶：弹起、变大）
    channels: { ...ZERO_CHANNELS, offsetY: 0.05, pitch: -0.05, scale: 1.025 },
    motion: { kind: 'bounce', amp: 0.025, freq: 2.4 },
    quiver: 0
  },
  shy: {
    // 微缩 + 低头 + 侧倾（害羞：缩小、藏起来）
    channels: { ...ZERO_CHANNELS, offsetY: -0.018, pitch: 0.1, roll: 0.07, scale: 0.95 },
    motion: { kind: 'sway', amp: 0.016, freq: 0.42 },
    quiver: 0
  },
  thinking: {
    // 侧倾 + 微转向（思考：歪头）
    channels: { ...ZERO_CHANNELS, pitch: -0.03, yaw: 0.08, roll: 0.15 },
    motion: { kind: 'sway', amp: 0.012, freq: 0.3 },
    quiver: 0
  },
  sleepy: {
    // 缓慢下沉 + 深长呼吸（困倦：慢慢陷下去）
    channels: { ...ZERO_CHANNELS, offsetY: -0.065, pitch: 0.14 },
    motion: { kind: 'breathe', amp: 0.015, freq: 0.13 },
    quiver: 0
  }
}

/**
 * 状态姿态表（非 idle 状态的静态增量 + 动态）。
 * walking 的动态由移动速度驱动（见 composePose 的 moveSpeed 分支，本表的 walking 项仅作兜底）。
 *
 * 注：无骨骼 → walking 不是真步态（无腿），用"轻快起伏 + 微前倾"表达在移动；
 * 待用户回 Meshy 绑骨 + 走路动画后，这里替换为 AnimationMixer 播放真步态（见报告"下一步"）。
 */
export const STATE_POSES: Record<PetState, GlbPose> = {
  idle: { channels: { ...ZERO_CHANNELS }, motion: NO_MOTION, quiver: 0 },
  walking: {
    channels: { ...ZERO_CHANNELS, pitch: 0.055 },
    motion: { kind: 'bounce', amp: 0.038, freq: 1.5 },
    quiver: 0
  },
  sleeping: {
    // 下沉 + 缓慢深吸（睡着：塌下去、呼吸放缓）；下沉量受构图约束（脚底贴容器底前为止）
    channels: { ...ZERO_CHANNELS, offsetY: -0.065, pitch: 0.09 },
    motion: { kind: 'breathe', amp: 0.014, freq: 0.2 },
    quiver: 0
  },
  thinking: {
    channels: { ...ZERO_CHANNELS, pitch: -0.03, yaw: 0.07, roll: 0.13 },
    motion: { kind: 'sway', amp: 0.012, freq: 0.3 },
    quiver: 0
  },
  speaking: {
    // 轻点头（说话：小幅频点头）
    channels: { ...ZERO_CHANNELS },
    motion: { kind: 'nod', amp: 0.045, freq: 2.6 },
    quiver: 0
  },
  dragging: {
    // 轻晃（被拖拽：左右轻摆，像挂着的软体）
    channels: { ...ZERO_CHANNELS },
    motion: { kind: 'sway', amp: 0.06, freq: 1.25 },
    quiver: 0
  }
}

/** 合成输入 */
export interface GlbPoseInput {
  emotion: Emotion
  /** 情绪强度 0–1（缩放情绪姿态幅度；不改变表现种类） */
  intensity: number
  state: PetState
  /** 窗口实际移动速度（px/s；由渲染器逐帧测速） */
  moveSpeed: number
}

/** 移动起伏的触发阈值（px/s）：低于此值视为静止 */
const MOVE_SPEED_THRESHOLD = 60
/** 步幅（px/步）：步频 = 速度 / 步幅（与 three-d 拟人步态同参数，节奏一致） */
const STRIDE_PX = 90

/**
 * 合成最终姿态。
 *
 * 静态通道 = 情绪（×强度系数） + 状态 + 移动前倾（三者相加，均为小量）；
 * 动态起伏按优先级"选一种"：状态（非 idle）> 移动（速度够大）> 情绪；
 * 移动前倾仅在 idle/walking 状态叠加（拖拽/睡觉/说话时不加，避免语义冲突）。
 */
export function composePose(input: GlbPoseInput): GlbPose {
  const { emotion, intensity, state, moveSpeed } = input
  const emo = EMOTION_POSES[emotion] ?? EMOTION_POSES.neutral
  const st = STATE_POSES[state] ?? STATE_POSES.idle

  // 强度系数：0.55–1.0（强度 0 也保留 55% 姿态——情绪切换仍可读，只是幅度小）
  const k = 0.55 + 0.45 * Math.min(1, Math.max(0, intensity))

  // ---- 静态通道相加 ----
  const channels: GlbChannels = {
    offsetY: emo.channels.offsetY * k + st.channels.offsetY,
    pitch: emo.channels.pitch * k + st.channels.pitch,
    yaw: emo.channels.yaw * k + st.channels.yaw,
    roll: emo.channels.roll * k + st.channels.roll,
    // 缩放：相乘（两处都是 ≈1 的微调）
    scale: 1 + (emo.channels.scale - 1) * k + (st.channels.scale - 1)
  }

  // ---- 移动感知（idle/walking 时叠加前倾 + 起伏；其它状态忽略） ----
  const moving = moveSpeed > MOVE_SPEED_THRESHOLD
  const canMove = state === 'idle' || state === 'walking'
  if (moving && canMove) {
    // 前倾随速度增大（最大 ~0.06 rad）；速度越大越"向前赶路"
    channels.pitch += Math.min(0.06, moveSpeed * 0.00025)
    // 起伏频率/幅度随速度（步频 = 速度 / 步幅，clamp [0.9, 2.8] 步/秒）
    const freq = Math.min(2.8, Math.max(0.9, moveSpeed / STRIDE_PX))
    const amp = Math.min(0.045, 0.015 + moveSpeed * 0.00012)
    return { channels, motion: { kind: 'bounce', amp, freq }, quiver: emo.quiver * k }
  }

  // ---- 动态起伏：状态优先（非 idle），否则用情绪动态 ----
  if (state !== 'idle') {
    return { channels, motion: st.motion, quiver: st.quiver + emo.quiver * k }
  }
  return { channels, motion: emo.motion, quiver: emo.quiver * k }
}

/** 摸头反应总时长（秒）：两次衰减弹跳 */
export const PET_REACTION_DURATION = 0.95

/**
 * 摸头反应：offsetY 增量（t = 反应已进行秒数；t 超时由调用方停止调用）。
 * 形状：两次"起跳→落地"（|sin| 半波），幅度指数衰减——像被摸头后开心地蹦两下。
 */
export function petReactionOffsetY(t: number): number {
  if (t < 0 || t >= PET_REACTION_DURATION) return 0
  const decay = Math.exp(-3.2 * t)
  return 0.075 * decay * Math.abs(Math.sin(Math.PI * 2.1 * t))
}

/** look_around 反应总时长（秒）：左右转头一轮 */
export const LOOK_AROUND_DURATION = 1.5

/**
 * look_around 反应：yaw 增量（t = 反应已进行秒数）。
 * 形状：sin 双周期 × sin 单周期包络——先向左看、再向右看、平滑归中（两端为零，无跳变）。
 */
export function lookAroundYaw(t: number): number {
  if (t < 0 || t >= LOOK_AROUND_DURATION) return 0
  const p = t / LOOK_AROUND_DURATION
  return 0.14 * Math.sin(p * Math.PI * 2) * Math.sin(p * Math.PI)
}

// ------------------------------------------------------------------ 魔法球捕获/释放反应（ball-animation 域）

/** 反应姿态增量（叠加在阻尼姿态/动态起伏之上；全部为 0/1 = 无反应） */
export interface GlbReactionPose {
  /** 竖直偏移增量（世界单位） */
  offsetY: number
  /** 前倾增量（弧度） */
  pitch: number
  /** 转向增量（弧度） */
  yaw: number
  /** 侧倾增量（弧度） */
  roll: number
  /** 缩放增量（1 = 不变） */
  scale: number
}

/** 零反应（无反应进行中时的默认值；模块内复用同一对象，调用方只读） */
export const ZERO_REACTION_POSE: GlbReactionPose = { offsetY: 0, pitch: 0, yaw: 0, roll: 0, scale: 1 }

/** 平滑阶跃（0→1，端点导数为零） */
function smoothstep01(x: number): number {
  const t = x < 0 ? 0 : x > 1 ? 1 : x
  return t * t * (3 - 2 * t)
}

/** captured 反应总时长（秒）：覆盖捕获缩小段（主进程 captureMs≈0.48s，取略长保证全程有表现） */
export const CAPTURED_REACTION_DURATION = 0.6

/**
 * 被抓反应（magic ball 捕获触发）：缩小 + 轻微前倾 + 挣扎抖动（yaw/roll 双频反相振荡）。
 * 窗口本身在同步缩小/移动（主进程），这里表现"蜷缩 + 挣动"的叠加姿态。
 * 注意：窗口 hide 可能在该时长之前发生（主进程时序），被截断是预期行为。
 */
export function capturedReactionPose(t: number): GlbReactionPose {
  if (t < 0 || t >= CAPTURED_REACTION_DURATION) return ZERO_REACTION_POSE
  const inP = smoothstep01(t / 0.14) // 快速进入（0.14s 内到位）
  const struggle = inP * (1 - 0.25 * (t / CAPTURED_REACTION_DURATION)) // 挣扎幅度缓慢减弱
  return {
    offsetY: 0.05 * inP * Math.exp(-1.6 * t) - 0.02 * inP, // 先被拎起一点、随即被按进"引力场"
    pitch: 0.06 * inP, // 蜷缩前倾
    yaw: 0.1 * struggle * Math.sin(t * Math.PI * 2 * 5.3), // 左右挣动（约 5Hz）
    roll: 0.13 * struggle * Math.sin(t * Math.PI * 2 * 7.1 + 0.9), // 侧倾挣动（约 7Hz，与 yaw 反相）
    scale: 1 - 0.14 * inP // 蜷缩缩小（叠加在窗口缩放的"体量感"上）
  }
}

/** released 反应总时长（秒）：与主进程 releaseMs≈0.52s + 落地 Q 弹余韵匹配 */
export const RELEASED_REACTION_DURATION = 0.95

/**
 * 被放回反应（magic ball 释放触发）：从缩小态弹性放大回弹（过冲到 ~1.05 再回落）
 * + 落地 Q 弹（两次衰减弹跳）+ 落稳前左右微摆——"被放回地上、站定"的观感。
 */
export function releasedReactionPose(t: number): GlbReactionPose {
  if (t < 0 || t >= RELEASED_REACTION_DURATION) return ZERO_REACTION_POSE
  const env = Math.exp(-4.2 * t)
  return {
    // scale：欠阻尼弹回 0.8 → 过冲 → 1.0（频率约 1.35Hz）
    scale: 1 - 0.2 * env * Math.cos(t * Math.PI * 2 * 1.35),
    // 落地弹跳：初始"从球里被托起"（+0.05 快速消去）+ 两次衰减弹跳
    offsetY: 0.05 * Math.exp(-6 * t) + 0.1 * Math.exp(-3.0 * t) * Math.abs(Math.sin(t * Math.PI * 2 * 1.6)),
    pitch: 0.06 * Math.exp(-3.2 * t), // 低头看地、随即起身
    yaw: 0,
    roll: 0.08 * Math.exp(-3.5 * t) * Math.sin(t * Math.PI * 2 * 1.2) // 落稳前左右微摆
  }
}
