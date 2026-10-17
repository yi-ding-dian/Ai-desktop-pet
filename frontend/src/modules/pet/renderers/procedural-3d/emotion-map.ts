/**
 * 情绪 → 3D 部件目标姿态映射（**"怎么调表情"看这里**）。
 *
 * 与 2D 版（part-animation/emotion-map.ts）同思路：
 * - 每种情绪给出一组**部件级目标姿态 PetPose3D**（眼形/嘴/腮红/头身姿态/耳朵/色偏…）；
 * - animator 负责把当前姿态向目标缓动（指数缓动，不是硬切），并叠加呼吸/眨眼等微行为；
 * - `intensity`（0–1，来自 WS emotion 事件）在 neutral 基线与目标之间线性插值：
 *   强度只影响"表情幅度"，不改变表情种类。
 *
 * 多模型架构（2026-10-14 兔子上线）：PetPose3D 是**超集**——
 * - 兔耳/尾巴字段（earLift/earSplay/earBack/earFold/earLiftDeltaL·R、tailWag）为**可选**：
 *   模型不消费则忽略、情绪表不写则取 neutral 基线；
 * - 本文件提供两张情绪表：`EMOTION_POSES`（企鹅，不含兔耳字段）与
 *   `RABBIT_EMOTION_POSES`（兔子，**耳朵姿态优先**，其余协同）。
 *
 * 3D 化说明（可爱优先）：
 * - 眼睛仍是主表情语言（eyeRound/eyeArc/eyeOpen/瞳孔缩放与视线），兔子另有细眉参与；
 * - 兔子的耳朵是第二表情语言（竖起/后压/垂下/内折/一竖一斜——见 RABBIT_EMOTION_POSES）；
 * - 嘴 = 上片微翘/下压（beakLift）+ 下片开合（mouthOpen，口型/哈欠/惊讶）；
 * - 头可以独立于身体摆（headTilt 歪头 / headPitch 低头抬头 / headYaw 转头）；
 * - 角度单位统一为**弧度**（书写用度 → deg() 换算）。
 */
import type { Emotion } from '../../../../shared/protocol'

const deg = (d: number): number => (d * Math.PI) / 180

/** 部件级姿态（渲染器"目标值"表示；角度 = 弧度，偏移 = 世界单位，其余为 0–1 归一量） */
export interface PetPose3D {
  // ---- 眼睛 ----
  /** 圆眼组（眼白+瞳孔+高光）可见度 0–1（眯眼笑时淡出） */
  eyeRound: number
  /** 眯眼笑弧线可见度 0–1 */
  eyeArc: number
  /** 眼睛基础开度：1 常态；<1 半闭（困/眯）；>1 瞪大（惊讶） */
  eyeOpen: number
  /** 瞳孔缩放（1 常态；惊讶放大 1.35） */
  pupilScale: number
  /** 视线偏移 -1..1（右/下为正；thinking 右上飘、sad 下垂） */
  lookX: number
  lookY: number
  /** 生气眉（内端下压）可见度 0–1 */
  browAngry: number
  /** 难过眉（内端上抬，八字）可见度 0–1 */
  browSad: number

  // ---- 嘴 ----
  /** 张口程度 0–1（惊讶大张 / 哈欠 / 口型驱动） */
  mouthOpen: number
  /** 上片俯仰：正 = 上翘（微笑），负 = 下压（难过/不满） */
  beakLift: number

  // ---- 脸 ----
  /** 腮红强度 0–1（映射到不透明度；shy 最浓） */
  blush: number
  blushColor: string

  // ---- 头与身体（弧度；3D 特有：头可独立于身体摆动） ----
  /** 身体倾斜（绕脚底，z 轴） */
  bodyTilt: number
  /** 头部附加侧倾（相对身体，z 轴；歪头） */
  headTilt: number
  /** 头部俯仰（x 轴；正 = 低头） */
  headPitch: number
  /** 头部偏转（y 轴；正 = 转向左[视觉右]侧） */
  headYaw: number
  /** 翅膀/小手附加角（z 轴；负 = 上抬展开，正 = 下垂内收） */
  wingAngle: number
  /** 呆毛弯曲（x 轴；正 = 向前耷拉，负 = 向后翘；兔子无呆毛，忽略） */
  hairBend: number
  /** 静息垂直偏移（世界单位；难过下沉、惊讶微弹起） */
  restOffsetY: number
  /** 情绪色偏：身体材质向此色插值 */
  tintColor: string
  tintAlpha: number

  // ---- 兔耳 / 尾巴（兔子专属超集字段；**可选**——企鹅不消费、情绪表不写即取基线） ----
  /** 双耳竖起度 0–1（0 = 完全垂下、1 = 竖直；0.55 = 自然微竖） */
  earLift?: number
  /** 左/右耳竖起度附加差（相对 earLift；thinking 一竖一斜、单耳抖动用） */
  earLiftDeltaL?: number
  earLiftDeltaR?: number
  /** 双耳前后摆（弧度；正 = 向后压/后飘、负 = 向前绷） */
  earBack?: number
  /** 双耳外张（弧度；正 = 向外张开、负 = 内收——shy 耳尖相碰） */
  earSplay?: number
  /** 耳尖内折 0–1（羞/委屈：耳尖向脸内折） */
  earFold?: number
  /** 尾巴摇摆（弧度；0 = 静止） */
  tailWag?: number
}

/** 基线姿态（neutral；也是所有强度插值的锚点。兔耳字段 = 兔子的自然耳） */
export const NEUTRAL_POSE: PetPose3D = {
  eyeRound: 1,
  eyeArc: 0,
  eyeOpen: 1,
  pupilScale: 1,
  lookX: 0,
  lookY: 0,
  browAngry: 0,
  browSad: 0,

  mouthOpen: 0,
  beakLift: 0,

  blush: 0.16,
  blushColor: '#FF9FB2',

  bodyTilt: 0,
  headTilt: 0,
  headPitch: 0,
  headYaw: 0,
  wingAngle: 0,
  hairBend: 0,
  restOffsetY: 0,
  tintColor: '#000000',
  tintAlpha: 0,

  // 兔耳自然基线：微竖（55%）+ 无附加摆（企鹅不消费，填了也无影响）
  earLift: 0.55,
  earLiftDeltaL: 0,
  earLiftDeltaR: 0,
  earBack: 0,
  earSplay: 0,
  earFold: 0,
  tailWag: 0
}

/** 企鹅 8 种情绪的目标姿态（与后端 EMOTION_VALUES 白名单对齐；不含兔耳字段） */
export const EMOTION_POSES: Record<Emotion, PetPose3D> = {
  neutral: NEUTRAL_POSE,

  // 开心：弯月笑眼 + 张嘴笑（上喙上翘）+ 腮红加深 + 翅膀上抬 + 呆毛后翘（像要蹦起来）
  happy: {
    ...NEUTRAL_POSE,
    eyeRound: 0,
    eyeArc: 1,
    lookY: -0.1,
    mouthOpen: 0.34,
    beakLift: deg(8),
    blush: 0.5,
    wingAngle: deg(-20),
    hairBend: deg(-14),
    headTilt: deg(2.5)
  },

  // 难过：眼半垂 + 八字眉 + 上喙下压 + 呆毛前耷 + 身体下沉 + 冷色调偏
  sad: {
    ...NEUTRAL_POSE,
    eyeOpen: 0.85,
    pupilScale: 0.92,
    lookY: 0.5,
    browSad: 1,
    beakLift: deg(-7),
    blush: 0,
    wingAngle: deg(9),
    hairBend: deg(20),
    restOffsetY: 0.02,
    headPitch: deg(5),
    tintColor: '#5B7BC4',
    tintAlpha: 0.12
  },

  // 生气：眯眼瞪 + 怒眉 + 微张口 + 脸颊涨红 + 翅膀炸起 + 呆毛立起 + 红偏
  angry: {
    ...NEUTRAL_POSE,
    eyeOpen: 0.78,
    pupilScale: 1.05,
    browAngry: 1,
    mouthOpen: 0.26,
    beakLift: deg(-6),
    blush: 0.55,
    blushColor: '#FF6E6E',
    wingAngle: deg(-24),
    hairBend: deg(-9),
    headPitch: deg(-3),
    tintColor: '#E05252',
    tintAlpha: 0.15
  },

  // 惊讶：瞪大眼 + 瞳孔放大 + O 形大张嘴 + 弹起 + 呆毛后竖
  surprised: {
    ...NEUTRAL_POSE,
    eyeOpen: 1.25,
    pupilScale: 1.35,
    mouthOpen: 0.8,
    blush: 0.25,
    wingAngle: deg(-32),
    hairBend: deg(-18),
    restOffsetY: -0.03,
    headPitch: deg(-4)
  },

  // 害羞：弯眼 + 视线躲开（低头侧望）+ 淡八字眉 + 抿嘴微翘 + 满脸通红 + 歪头
  shy: {
    ...NEUTRAL_POSE,
    eyeRound: 0.1,
    eyeArc: 0.95,
    eyeOpen: 0.95,
    lookX: -0.35,
    lookY: 0.3,
    browSad: 0.35,
    mouthOpen: 0.05,
    beakLift: deg(3.5),
    blush: 0.95,
    wingAngle: deg(6),
    hairBend: deg(8),
    bodyTilt: deg(-2),
    headTilt: deg(-6),
    headYaw: deg(-9),
    headPitch: deg(3)
  },

  // 思考：视线右上飘 + 歪头 + 上喙微撇 + 呆毛前倾
  thinking: {
    ...NEUTRAL_POSE,
    eyeOpen: 0.92,
    pupilScale: 0.95,
    lookX: 0.6,
    lookY: -0.55,
    mouthOpen: 0,
    beakLift: deg(-2.5),
    blush: 0.1,
    headTilt: deg(8),
    headYaw: deg(6),
    wingAngle: deg(7),
    hairBend: deg(12)
  },

  // 困倦：眼睛几乎闭合 + 视线下垂 + 小哈欠 + 呆毛耷拉 + 低头 + 紫偏
  sleepy: {
    ...NEUTRAL_POSE,
    eyeOpen: 0.13,
    pupilScale: 0.9,
    lookY: 0.25,
    mouthOpen: 0.2,
    beakLift: deg(-1.5),
    blush: 0.3,
    wingAngle: deg(10),
    hairBend: deg(17),
    restOffsetY: 0.02,
    headTilt: deg(-2.5),
    headPitch: deg(4.5),
    tintColor: '#7C6BD8',
    tintAlpha: 0.1
  }
}

/**
 * 兔子 8 种情绪的目标姿态（**耳朵姿态优先**，与后端 EMOTION_VALUES 白名单对齐）。
 * 耳朵映射（用户 2026-10-14 需求）：
 *   happy = 双耳竖起；sad/sleepy = 双耳垂下；angry = 双耳后压；
 *   surprised = 猛竖（over-lift）；shy = 耳尖相碰/内折；thinking = 一竖一斜；neutral = 自然弯。
 * 其余部件（眼形/眉/嘴/腮红/头身倾斜）协同；呆毛/尾巴字段兔子不消费（忽略）。
 * 色偏比企鹅版略淡（白兔染色更醒目，避免"变蓝兔"）。
 */
export const RABBIT_EMOTION_POSES: Record<Emotion, PetPose3D> = {
  neutral: { ...NEUTRAL_POSE, blush: 0.42 },

  // 开心：双耳竖起（1）+ 微后仰 + 弯月笑眼 + 张嘴笑 + 腮红深 + 抬臂 + 微歪头
  happy: {
    ...NEUTRAL_POSE,
    earLift: 1,
    earBack: deg(5),
    eyeRound: 0,
    eyeArc: 1,
    lookY: -0.1,
    mouthOpen: 0.34,
    beakLift: deg(8),
    blush: 0.62,
    wingAngle: deg(-20),
    headTilt: deg(2.5)
  },

  // 难过：双耳垂下（0.03）+ 外垂微张 + 眼半垂 + 八字眉 + 嘴下压 + 下沉 + 冷色微偏
  sad: {
    ...NEUTRAL_POSE,
    earLift: 0.03,
    earSplay: deg(18),
    earBack: deg(-6),
    eyeOpen: 0.85,
    pupilScale: 0.92,
    lookY: 0.5,
    browSad: 1,
    beakLift: deg(-7),
    blush: 0.06,
    wingAngle: deg(9),
    restOffsetY: 0.02,
    headPitch: deg(5),
    tintColor: '#5B7BC4',
    tintAlpha: 0.1
  },

  // 生气：双耳后压（0.65 rad）+ 眯眼瞪 + 怒眉 + 微张口 + 脸颊涨红 + 双臂炸起 + 红微偏
  angry: {
    ...NEUTRAL_POSE,
    earLift: 0.85,
    earBack: deg(38),
    earSplay: deg(8),
    eyeOpen: 0.78,
    pupilScale: 1.05,
    browAngry: 1,
    mouthOpen: 0.26,
    beakLift: deg(-6),
    blush: 0.62,
    blushColor: '#FF6E6E',
    wingAngle: deg(-24),
    headPitch: deg(-3),
    tintColor: '#E05252',
    tintAlpha: 0.13
  },

  // 惊讶：双耳猛地竖直（1.12，over-lift 拉长）+ 瞪大眼 + 瞳孔放大 + O 形大张嘴 + 弹起
  surprised: {
    ...NEUTRAL_POSE,
    earLift: 1.12,
    earSplay: deg(-4),
    eyeOpen: 1.25,
    pupilScale: 1.35,
    mouthOpen: 0.8,
    blush: 0.35,
    wingAngle: deg(-32),
    restOffsetY: -0.03,
    headPitch: deg(-4)
  },

  // 害羞：耳尖相碰（内收 + 内折）+ 弯眼 + 视线躲 + 淡八字眉 + 抿嘴 + 满脸通红 + 歪头
  shy: {
    ...NEUTRAL_POSE,
    earLift: 0.5,
    earSplay: deg(-17),
    earFold: 0.85,
    earBack: deg(-8),
    eyeRound: 0.1,
    eyeArc: 0.95,
    eyeOpen: 0.95,
    lookX: -0.35,
    lookY: 0.3,
    browSad: 0.35,
    mouthOpen: 0.05,
    beakLift: deg(3.5),
    blush: 0.95,
    wingAngle: deg(6),
    bodyTilt: deg(-2),
    headTilt: deg(-6),
    headYaw: deg(-9),
    headPitch: deg(3)
  },

  // 思考：一竖一斜（左耳 +0.4 / 右耳 -0.35）+ 视线右上飘 + 歪头 + 上唇微撇
  thinking: {
    ...NEUTRAL_POSE,
    earLift: 0.6,
    earLiftDeltaL: 0.4,
    earLiftDeltaR: -0.35,
    earSplay: deg(4),
    eyeOpen: 0.92,
    pupilScale: 0.95,
    lookX: 0.6,
    lookY: -0.55,
    mouthOpen: 0,
    beakLift: deg(-2.5),
    blush: 0.3,
    headTilt: deg(8),
    headYaw: deg(6),
    wingAngle: deg(7)
  },

  // 困倦：双耳垂下（0.1）+ 微后 + 眯缝眼 + 视线下垂 + 小哈欠 + 低头 + 紫微偏
  sleepy: {
    ...NEUTRAL_POSE,
    earLift: 0.1,
    earBack: deg(9),
    earSplay: deg(6),
    eyeOpen: 0.13,
    pupilScale: 0.9,
    lookY: 0.25,
    mouthOpen: 0.2,
    beakLift: deg(-1.5),
    blush: 0.42,
    wingAngle: deg(10),
    restOffsetY: 0.02,
    headTilt: deg(-2.5),
    headPitch: deg(4.5),
    tintColor: '#7C6BD8',
    tintAlpha: 0.08
  }
}

/** 情绪白名单（与 shared/protocol EMOTION_VALUES 一致；冗余一份以免运行时互相耦合） */
const KNOWN_EMOTIONS: ReadonlySet<string> = new Set(Object.keys(EMOTION_POSES))

/** 白名单外/未知情绪回退 neutral */
export function normalizeEmotion(emotion: string): Emotion {
  return (KNOWN_EMOTIONS.has(emotion) ? emotion : 'neutral') as Emotion
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v)

/**
 * 解析情绪 → 目标姿态（含强度插值）。`poses` 为模型自带情绪表（缺省企鹅表）。
 * intensity：0 = 完全 neutral 基线，1 = 完整表情（缺省 1）。
 * 超集字段缺失（表里没写）→ 取 neutral 基线值（"缺失即忽略"）。
 */
export function resolveEmotionPose(
  emotion: string,
  intensity = 1,
  poses: Record<Emotion, PetPose3D> = EMOTION_POSES
): PetPose3D {
  const target = poses[normalizeEmotion(emotion)]
  const k = clamp01(intensity)
  if (k >= 1) return target

  // 数值字段在基线↔目标之间插值；字符串（颜色）直接取目标；可选字段缺省取基线
  const out = {} as Record<keyof PetPose3D, PetPose3D[keyof PetPose3D]>
  for (const key of Object.keys(NEUTRAL_POSE) as Array<keyof PetPose3D>) {
    const base = NEUTRAL_POSE[key]
    const goal = target[key] ?? base
    out[key] = typeof base === 'number' && typeof goal === 'number' ? base + (goal - base) * k : goal
  }
  return out as unknown as PetPose3D
}
