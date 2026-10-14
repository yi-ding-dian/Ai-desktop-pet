/**
 * 情绪 → 部件目标参数映射（**"怎么调表情"看这里**）。
 *
 * 设计（对齐设计文档 §5.3 "情绪映射（模型适配层）"的思路，先内置成代码表）：
 * - 每种情绪给出一组**部件级目标姿态 PetPose**（眼形/嘴形/腮红/身体倾斜/色偏…）；
 * - animator 负责把当前姿态向目标缓动（不是硬切），并叠加呼吸/眨眼等微行为；
 * - `intensity`（0–1，来自 WS emotion 事件）在 neutral 基线与目标姿态之间线性插值：
 *   强度只影响"表情幅度"，不改变表情种类。
 *
 * 新增/调整表情：只需在 EMOTION_POSES 里改对应条目（或改 NEUTRAL_POSE 基线）。
 * 注意：颜色字段（blushColor/tintColor）不参与强度插值，强度通过透明度字段体现。
 */
import type { Emotion } from '../../../../shared/protocol'

/** 部件级姿态（渲染器的"目标值"表示；全部为归一化/相对量，与 viewBox 尺寸解耦） */
export interface PetPose {
  // ---- 眼睛 ----
  /** 圆眼组（眼白+瞳孔+高光）可见度 0–1（笑眼时淡出） */
  eyeRound: number
  /** 笑眼弧线可见度 0–1（happy 等） */
  eyeArc: number
  /** 眼睛基础开度：1 常态；<1 半闭（困/眯）；>1 瞪大（惊讶） */
  eyeOpen: number
  /** 瞳孔缩放（1 常态；惊讶放大） */
  pupilScale: number
  /** 瞳孔偏移 -1..1（右/下为正；thinking 向上飘、sad 下垂） */
  lookX: number
  lookY: number
  /** 生气眉（外高内低）可见度 0–1 */
  browAngry: number
  /** 难过眉（内高外低，八字）可见度 0–1 */
  browSad: number

  // ---- 嘴 ----
  /** 嘴宽乘数（相对 config.mouth.baseWidth） */
  mouthWidth: number
  /** 嘴角弧线：-1 下垂 .. 0 平 .. 1 上翘 */
  mouthCurve: number
  /** 张口程度 0–1（surprised 大张、speaking 由口型驱动） */
  mouthOpen: number

  // ---- 脸 ----
  /** 腮红强度 0–1（映射到透明度；shy 最浓） */
  blush: number
  blushColor: string

  // ---- 身体 ----
  /** 身体倾斜（度，绕脚底中心；thinking 歪头） */
  tilt: number
  /** 翅膀附加角（度；负 = 上抬展开，正 = 下垂） */
  wingAngle: number
  /** 呆毛弯曲（度，绕根部旋转；难过/困时耷拉） */
  hairBend: number
  /** 静息垂直偏移（viewBox px；难过时下沉、惊讶时弹起） */
  restOffsetY: number
  /** 情绪色偏：叠加在身体上的同形状颜色层 */
  tintColor: string
  tintAlpha: number
}

/** 基线姿态（neutral；也是所有强度插值的锚点） */
export const NEUTRAL_POSE: PetPose = {
  eyeRound: 1,
  eyeArc: 0,
  eyeOpen: 1,
  pupilScale: 1,
  lookX: 0,
  lookY: 0,
  browAngry: 0,
  browSad: 0,

  mouthWidth: 1,
  mouthCurve: 0.15,
  mouthOpen: 0,

  blush: 0.16,
  blushColor: '#FF9BAB',

  tilt: 0,
  wingAngle: 0,
  hairBend: 0,
  restOffsetY: 0,
  tintColor: '#000000',
  tintAlpha: 0
}

/** 8 种情绪的目标姿态（v1 白名单，与后端 EMOTION_VALUES 对齐） */
export const EMOTION_POSES: Record<Emotion, PetPose> = {
  neutral: NEUTRAL_POSE,

  // 开心：弯月笑眼 + 张嘴笑 + 腮红加深 + 翅膀上抬 + 呆毛后甩（像蹦起来）
  happy: {
    ...NEUTRAL_POSE,
    eyeRound: 0,
    eyeArc: 1,
    lookY: -0.1,
    mouthWidth: 1.15,
    mouthCurve: 1,
    mouthOpen: 0.35,
    blush: 0.5,
    wingAngle: -22,
    hairBend: -12
  },

  // 难过：眼半垂 + 八字眉 + 嘴角下垂 + 呆毛耷拉 + 微微下沉 + 冷色调偏
  sad: {
    ...NEUTRAL_POSE,
    eyeOpen: 0.85,
    pupilScale: 0.92,
    lookY: 0.5,
    browSad: 1,
    mouthWidth: 0.85,
    mouthCurve: -0.85,
    blush: 0,
    wingAngle: 9,
    hairBend: -20,
    restOffsetY: 3,
    tintColor: '#5B7BC4',
    tintAlpha: 0.12
  },

  // 生气：瞪眼眯缝 + 怒眉 + 咧嘴 + 脸颊涨红 + 翅膀炸起 + 呆毛竖立 + 红偏
  angry: {
    ...NEUTRAL_POSE,
    eyeOpen: 0.8,
    pupilScale: 1.05,
    browAngry: 1,
    mouthWidth: 0.95,
    mouthCurve: -0.5,
    mouthOpen: 0.3,
    blush: 0.55,
    blushColor: '#FF6E6E',
    wingAngle: -26,
    hairBend: 14,
    tintColor: '#E05252',
    tintAlpha: 0.15
  },

  // 惊讶：瞪大眼 + 缩小瞳孔（反差萌）/放大瞳孔二选一 → 放大更"受惊可爱" + O 形嘴 + 弹起 + 呆毛竖直
  surprised: {
    ...NEUTRAL_POSE,
    eyeOpen: 1.2,
    pupilScale: 1.35,
    mouthWidth: 0.62,
    mouthCurve: 0,
    mouthOpen: 0.85,
    blush: 0.25,
    wingAngle: -38,
    hairBend: -30,
    restOffsetY: -5
  },

  // 害羞：弯眼 + 视线躲开 + 淡淡八字眉 + 抿嘴微笑 + 满脸通红 + 微微歪头
  shy: {
    ...NEUTRAL_POSE,
    eyeRound: 0.1,
    eyeArc: 0.95,
    eyeOpen: 0.95,
    lookX: -0.35,
    lookY: 0.35,
    browSad: 0.35,
    mouthWidth: 0.68,
    mouthCurve: 0.55,
    mouthOpen: 0.05,
    blush: 0.95,
    wingAngle: 5,
    hairBend: -8,
    tilt: -2
  },

  // 思考：眼睛上飘 + 歪头 + 抿嘴微撇 + 呆毛前倾
  thinking: {
    ...NEUTRAL_POSE,
    eyeOpen: 0.92,
    pupilScale: 0.95,
    lookX: 0.6,
    lookY: -0.55,
    mouthWidth: 0.78,
    mouthCurve: -0.25,
    blush: 0.1,
    tilt: 7,
    wingAngle: 6,
    hairBend: 8
  },

  // 困倦：眼睛几乎闭合 + 视线下垂 + 小哈欠嘴 + 呆毛耷拉 + 身体下沉 + 紫偏
  sleepy: {
    ...NEUTRAL_POSE,
    eyeOpen: 0.15,
    pupilScale: 0.9,
    lookY: 0.25,
    mouthWidth: 0.6,
    mouthCurve: 0.1,
    mouthOpen: 0.25,
    blush: 0.3,
    wingAngle: 10,
    hairBend: -22,
    restOffsetY: 3,
    tilt: -2,
    tintColor: '#7C6BD8',
    tintAlpha: 0.1
  }
}

/** 情绪白名单（与 shared/protocol EMOTION_VALUES 一致；此处冗余一份以免运行时互相耦合） */
const KNOWN_EMOTIONS: ReadonlySet<string> = new Set(Object.keys(EMOTION_POSES))

/** 白名单外/未知情绪回退 neutral */
export function normalizeEmotion(emotion: string): Emotion {
  return (KNOWN_EMOTIONS.has(emotion) ? emotion : 'neutral') as Emotion
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v)

/**
 * 解析情绪 → 目标姿态（含强度插值）。
 * intensity：0 = 完全 neutral 基线，1 = 完整表情（缺省 1）。
 */
export function resolveEmotionPose(emotion: string, intensity = 1): PetPose {
  const target = EMOTION_POSES[normalizeEmotion(emotion)]
  const k = clamp01(intensity)
  if (k >= 1) return target

  // 数值字段在基线↔目标之间插值；字符串（颜色）直接取目标
  const out = {} as Record<keyof PetPose, PetPose[keyof PetPose]>
  for (const key of Object.keys(NEUTRAL_POSE) as Array<keyof PetPose>) {
    const base = NEUTRAL_POSE[key]
    const goal = target[key]
    out[key] = typeof base === 'number' && typeof goal === 'number' ? base + (goal - base) * k : goal
  }
  return out as unknown as PetPose
}
