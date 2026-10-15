/**
 * SVG 表情层配置（glb-model 渲染器的内部实现细节；PetRenderer 接口零改动）。
 *
 * 背景：GLB 兔子是单节点静态网格（面部为烘焙贴图，无骨骼/无形状键），情绪原本只能靠
 * 整体姿态表达。本模块把 **SVG 表情叠加层** 叠在 Three.js 画布之上：影子眼皮（眨眼）、
 * 眉毛、泪光、腮红、符号等 2D 元素跟随 3D 头部/整体姿态投影，实现"脸上有反应"。
 *
 * ── 坐标系（本文件所有 x/y/r 的默认单位）────────────────────────────────────────
 * **脸坐标系**（随 3D 模型一起运动，2D 元素都在这个系里排版）：
 *   - 原点 O = 两眼中点（模型本地坐标）；
 *   - +x = 观察者右侧（沿眼L→眼R 连线方向）；
 *   - +y = 屏幕下方（脸法线方向叉乘得到，静止时 ≈ 世界 -y）；
 *   - 单位 = 世界单位（模型总高 ≈ 1.078；两侧眼距 ≈ 0.231）。
 * 换算参考：832² 标定截图下 1 世界单位 ≈ 703 px；**真机 208px 容器下 1 世界单位 ≈ 176 px**，
 * 即眼睛宽（0.11 单位）≈ 19 px、表情线宽 0.008 单位 ≈ 1.4 px。
 * 渲染器每帧把 O、O+ex、O+eyDown 三个本地向量投影到屏幕，得到脸坐标系的 2D 仿射矩阵
 * （见 overlay.ts），因此**所有元素自动跟随头部/整体姿态**（弹跳、歪头、转头、缩放）。
 *
 * ── 锚点标定方法（2026-10-15）─────────────────────────────────────────────────
 * ① 独立 Electron 离屏页按渲染器同参数静态渲染 832² 中性截图（/tmp/pet-svg-face/）；
 * ② 像素分析（绿虹膜簇 + 暗描边簇 + 淡粉鼻/嘴聚类）定位各特征中心与半径；
 * ③ 从相机向像素发射射线与模型求交（THREE.Raycaster），把命中点换算到脸坐标系
 *    （见 /tmp/pet-svg-face/calibrate-entry.ts 的 anchors()，标度 703px/单位各向同性）。
 * 如需重标定（换模型/换相机）：改 FACE_FRAME 与 ANCHORS 即可，overlay.ts 不用动。
 */
import type { Emotion, PetState } from '../../../../../shared/protocol'

// ------------------------------------------------------------------ 脸坐标系（标定值）

/** 脸坐标系原点（两眼中点，模型本地坐标） */
export const FACE_ORIGIN: readonly [number, number, number] = [0.0527, 0.5864, 0.2178]
/** 脸坐标系 +x 单位向量（眼L → 眼R；模型本地坐标） */
export const FACE_EX: readonly [number, number, number] = [0.9967, 0.0801, -0.0151]
/** 脸坐标系 +y 单位向量（屏幕下方；模型本地坐标） */
export const FACE_EY_DOWN: readonly [number, number, number] = [0.0802, -0.9968, 0]
/**
 * 每帧投影采样偏移（世界单位）：在 O 处沿 ex/eyDown 取小增量做**局部线性化**，
 * 把"世界单位 → 屏幕 px"的雅可比当仿射矩阵用（透视非线性误差 <0.5px，见报告）。
 */
export const FACE_PROBE = 0.05

// ------------------------------------------------------------------ 脸部锚点（标定值）

/** 脸部锚点（脸坐标系；x/y = 中心，rx/ry = 椭圆半轴，单位 = 世界单位） */
export interface FaceAnchor {
  x: number
  y: number
  rx: number
  ry: number
}

/**
 * 各特征锚点（832² 截图像素 → 脸坐标系，标定见文件头）。
 * 微调示例：眼皮没盖住眼睛 → 增大对应 eye 的 rx/ry；腮红偏上 → 减小 cheekL/cheekR 的 y。
 */
export const ANCHORS: Record<'eyeL' | 'eyeR' | 'nose' | 'mouth' | 'cheekL' | 'cheekR' | 'headTop', FaceAnchor> = {
  /** 左眼（观察者视角左；眼宽 79px/高 62px @832² 截图，含睫毛外沿） */
  eyeL: { x: -0.1156, y: 0, rx: 0.0569, ry: 0.0455 },
  /** 右眼（眼宽 73px/高 56px） */
  eyeR: { x: 0.1156, y: 0, rx: 0.0526, ry: 0.0426 },
  /** 鼻头（粉色三角，宽 41px/高 24px） */
  nose: { x: -0.0001, y: 0.057, rx: 0.0327, ry: 0.0256 },
  /** 嘴（ω 形微笑线区域，宽 80px/高 38px） */
  mouth: { x: -0.0032, y: 0.0971, rx: 0.0569, ry: 0.027 },
  /** 左脸颊腮红中心 */
  cheekL: { x: -0.2094, y: 0.0666, rx: 0.074, ry: 0.0483 },
  /** 右脸颊腮红中心 */
  cheekR: { x: 0.1849, y: 0.1079, rx: 0.074, ry: 0.0483 },
  /** 头顶中线（两耳之间的头顶点；符号类元素以它为基准） */
  headTop: { x: 0.032, y: -0.2372, rx: 0, ry: 0 }
}

// ------------------------------------------------------------------ 调色板

/**
 * 颜色（直接用 sRGB 色值：SVG 层不过 Three 的 ACES 色调映射，故眼皮等"贴脸"色标定时
 * 从**渲染后截图**取样，保证与 3D 皮肤观感一致）。
 */
export const COLORS = {
  /** 眼皮（脸部肤色；取自标定截图眼周实测 ≈ rgb(219,213,204)，略提亮避免"贴膏药"感） */
  lid: '#ded8ce',
  /** 眼睑线（闭眼/眯眼时在眼皮下缘描的柔和线） */
  lidLine: '#c7b39c',
  /** 表情线（眉毛/笑弧）——比 3D 睫毛(深棕)浅一档，避免叠加显凶 */
  ink: '#a07c5b',
  /** 腮红（柔粉；径向渐变中心色，外圈透明） */
  blush: '#f0928c',
  /** 惊讶张嘴：内腔 + 边缘 */
  mouthIn: '#8a5a52',
  mouthEdge: '#c48d80',
  /** 泪光（淡蓝白，微透） */
  tear: '#eaf4ff',
  /** 符号（？/Zzz） */
  symbol: '#a58a72',
  /** 井号（生气，偏红） */
  symbolHot: '#dd8068'
}

// ------------------------------------------------------------------ 表情参数

/** 眉毛形态（none=不显示；one=仅右眉上挑，thinking 用） */
export type BrowKind = 'none' | 'sad' | 'angry' | 'raise' | 'one'
/** 头顶符号（question=？ anger=井 zzz=Zzz） */
export type SymbolKind = 'none' | 'question' | 'anger' | 'zzz'

/** 单个情绪的"脸部表情"参数（连续量由渲染器逐帧阻尼，开关量走 CSS 过渡） */
export interface FaceExpression {
  /** 上眼皮闭合度 0–1（1=全闭；眨眼在此基础上取 max） */
  lidTop: number
  /** 下眼皮闭合度 0–1（happy/shy 的"笑眼"：下眼睑上抬挤出弯月缝） */
  lidBot: number
  /** 腮红强度 0–1（最终透明度 = 本值 × 强度系数；0=不显示） */
  blush: number
  /** 眉毛形态 */
  brow: BrowKind
  /** 泪光点缀（sad） */
  tears: boolean
  /** "///" 短斜线（shy） */
  squiggle: boolean
  /** 小张嘴（surprised） */
  openMouth: boolean
  /** 瞪眼外圈（surprised） */
  eyeRing: boolean
  /** 头顶符号 */
  symbol: SymbolKind
}

/**
 * 8 情绪 → 表情表（"克制可爱"取向：闭合度 ≤0.6、线条浅、腮红不糊脸）。
 * 调参入口：想"笑得再眯一点"→ 调 happy.lidBot（0.6→0.7）；想"生气更凶"→ angry.brow + lidTop。
 */
export const EMOTION_FACES: Record<Emotion, FaceExpression> = {
  neutral: {
    lidTop: 0,
    lidBot: 0,
    blush: 0.22, // 极淡腮红（保底可爱感；0 = 完全不显示）
    brow: 'none',
    tears: false,
    squiggle: false,
    openMouth: false,
    eyeRing: false,
    symbol: 'none'
  },
  happy: {
    // 笑眼：下眼睑上抬 + 上眼皮下压 → 挤出弯月缝，上下眼睑线自动显形为"笑弧"
    lidTop: 0.25,
    lidBot: 0.6,
    blush: 0.62, // "腮红加深"
    brow: 'none',
    tears: false,
    squiggle: false,
    openMouth: false,
    eyeRing: false,
    symbol: 'none'
  },
  sad: {
    // 八字眉 + 泪光 + 微微垂眼
    lidTop: 0.2,
    lidBot: 0.05,
    blush: 0.16,
    brow: 'sad',
    tears: true,
    squiggle: false,
    openMouth: false,
    eyeRing: false,
    symbol: 'none'
  },
  angry: {
    // 怒眉 + 井号 + 压低眼皮（瞪）
    lidTop: 0.28,
    lidBot: 0,
    blush: 0.4,
    brow: 'angry',
    tears: false,
    squiggle: false,
    openMouth: false,
    eyeRing: false,
    symbol: 'anger'
  },
  surprised: {
    // 挑眉 + 瞪眼外圈 + 小张嘴（不遮眼）
    lidTop: 0,
    lidBot: 0,
    blush: 0.3,
    brow: 'raise',
    tears: false,
    squiggle: false,
    openMouth: true,
    eyeRing: true,
    symbol: 'none'
  },
  shy: {
    // 大红脸 + "///" + 半眯
    lidTop: 0.3,
    lidBot: 0.35,
    blush: 1.0,
    brow: 'none',
    tears: false,
    squiggle: true,
    openMouth: false,
    eyeRing: false,
    symbol: 'none'
  },
  thinking: {
    // 单侧眉上挑 + 头顶"？" + 微眯
    lidTop: 0.22,
    lidBot: 0.1,
    blush: 0.28,
    brow: 'one',
    tears: false,
    squiggle: false,
    openMouth: false,
    eyeRing: false,
    symbol: 'question'
  },
  sleepy: {
    // 眼皮半合（40% 停留，任务指定）+ Zzz
    lidTop: 0.4,
    lidBot: 0,
    blush: 0.32,
    brow: 'none',
    tears: false,
    squiggle: false,
    openMouth: false,
    eyeRing: false,
    symbol: 'zzz'
  }
}

/** 腮红最终基色透明度（0–1；再乘 FaceExpression.blush 与强度系数） */
export const BLUSH_ALPHA_MAX = 0.85

// ------------------------------------------------------------------ 眨眼与动态

/** 眨眼参数（全为秒） */
export const BLINK = {
  /** 单次眨眼全程（下合 + 抬起） */
  duration: 0.15,
  /** 随机间隔范围 */
  minGap: 2,
  maxGap: 6,
  /** 首次眨眼间隔 = 随机间隔 × 本系数（更快展示，调试友好） */
  firstGapScale: 0.45,
  /** 双眨概率与两次之间的间隔 */
  doubleChance: 0.18,
  doubleGap: 0.26,
  /** 曲线形状指数（1=纯 sin 半波；<1 更快合上、慢抬起） */
  shapePow: 0.85
}

/** 眼皮位移参数（相对眼睛 ry 的倍数；眼皮形状见 overlay.ts 的 buildLidShape） */
export const LID = {
  /** 上眼皮全开基线（负 = 藏进上眼睑外；需 ≤ -1.75） */
  openBase: -2.0,
  /** 上眼皮全闭基线（下缘弧最深点 = base + 0.6；需 ≥ 0.55 才能盖满） */
  closedBase: 0.62,
  /** 下眼皮全开基线（正 = 藏进下眼睑外；需 ≥ 1.75） */
  openBot: 2.0,
  /** 下眼皮全闭基线（上缘弧最深点 = base - 0.6；需 ≤ -0.55 才能盖满） */
  closedBot: -0.62,
  /** 眼皮下缘二次贝塞尔控制点下探量（相对 ry） */
  edgeDrop: 1.2,
  /** 眼睑线可见度曲线：p 超过 from 后线性渐显，到 to 达到 1 */
  lineFrom: 0.4,
  lineTo: 0.85
}

/** 眼皮闭合度阻尼时间常数（秒）：情绪切换时眼皮平滑归位 */
export const TAU_LID = 0.12

/** 睡着（state='sleeping'）时的表情覆盖：闭大半眼 + Zzz + 停眨 */
export const SLEEP_OVERRIDE = {
  /** 上眼皮闭合度下限 */
  lidTop: 0.72,
  /** 是否还有 Zzz 符号（与情绪 symbol 取或） */
  symbolZzz: true
}

/** 强度（setEmotion 的 intensity）对表情的缩放：blush 与眼皮闭合的系数范围 */
export const INTENSITY = {
  /** blush 系数 = low + (1-low)*intensity */
  blushLow: 0.5,
  /** 眼皮闭合系数 = low + (1-low)*intensity（下限别太低，否则强度 0 时表情读不出来） */
  lidLow: 0.7
}

// ------------------------------------------------------------------ 眉毛 / 符号几何

/**
 * 眉毛几何（相对眼睛中心，单位 ry/rx 倍数；y 负 = 眼睛上方）。
 * inward 指"朝脸中线"方向（左眼为 +x，右眼为 -x），内外端 y 差决定情绪方向：
 * sad 内高外低（八字）、angry 内低外高（八字倒）。
 */
export const BROW = {
  /** 距眼睛中心的纵向距离（ry 倍数；与眼上缘 -1.15 保持空隙） */
  y: -1.78,
  raiseY: -2.15,
  /** 半长（rx 倍数） */
  halfLen: 1.0,
  /** 线宽（世界单位） */
  width: 0.0085,
  /** sad/angry 的内外端纵向落差（ry 倍数） */
  tilt: 0.42
}

/**
 * 头顶符号布局（**相对 headTop 锚点的偏移**，脸坐标系）。
 * 换算备忘：绝对 relY = headTop.y + 本偏移。目标落点在"两耳之间的头顶上方"
 * （屏幕 x 380–435 / y 150–240 @832² 截图）：耳朵在两侧，x 过大符号会叠在耳朵上
 * （标定核过：绝对 relX 超过 ~0.05 即压右耳）。
 */
export const SYMBOLS = {
  /** 绝对 (0.012,-0.32)，屏幕 ≈ (424,178)：头顶上方、略偏右 */
  question: { x: -0.02, y: -0.083, size: 0.08 },
  /** 绝对 (0.008,-0.28)，屏幕 ≈ (416,206)：头顶上方、正偏右 */
  anger: { x: -0.024, y: -0.043, size: 0.038 },
  /** Zzz 三个 Z（从下到上、向右上飘）；绝对位置 ≈ (-0.02,-0.25) / (0,-0.31) / (0.02,-0.37) */
  zzz: [
    { x: -0.052, y: -0.013, size: 0.055 },
    { x: -0.032, y: -0.073, size: 0.045 },
    { x: -0.012, y: -0.133, size: 0.036 }
  ] as const
}

/** 泪光位置（相对眼睛中心；outer = 朝脸外侧方向） */
export const TEAR = { x: 0.92, y: 0.72, r1: 0.0125, r2: 0.0075 }
/** "///" 短斜线（相对腮红中心） */
export const SQUIGGLE = { x: 0.012, y: -0.052, len: 0.022, gap: 0.011, width: 0.005 }
/** 惊讶小张嘴（相对嘴锚点） */
export const OPEN_MOUTH = { x: 0.002, y: 0.012, rx: 0.02, ry: 0.027 }
/** 瞪眼外圈（相对眼睛半径倍数 + 线宽） */
export const EYE_RING = { scale: 1.2, width: 0.006 }

/**
 * 状态相关的表情覆盖（目前仅 sleeping；返回 null = 不覆盖）。
 * 说明：state='thinking'/'speaking' 等不覆盖表情层（情绪已表达；避免双写打架）。
 */
export function stateFaceOverride(state: PetState): { lidTop: number; zzz: boolean } | null {
  if (state === 'sleeping') return { lidTop: SLEEP_OVERRIDE.lidTop, zzz: SLEEP_OVERRIDE.symbolZzz }
  return null
}
