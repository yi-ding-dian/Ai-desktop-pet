/**
 * 3D 渲染器共享层：通用部件句柄类型 + 模型选择 + 造型基元类型。
 *
 * 多模型架构（2026-10-14 兔子上线）：
 * - procedural-3d 渲染器支持多个程序化模型（`models/penguin.ts`、`models/rabbit.ts`），
 *   每个模型自带造型参数（写在各自的模型文件里，仍是"唯一造型事实来源"）、
 *   建模函数（build）与专属逐帧写入（applyExtras 闭包）；
 * - 本文件的 `PetParts3D` 是**两模型共用的句柄超集**：通用部件（根/头/眼/嘴/腮红/
 *   心形粒子/色偏）由渲染器外壳的 applyFrame 统一驱动；模型专属部件（呆毛/肉翅/
 *   兔耳/兔尾…）由各自模型的 applyExtras 驱动——**帧数据里不消费的字段直接忽略**；
 * - 情绪姿态（emotion-map 的 PetPose3D）同样是超集：兔耳/尾巴字段为可选，
 *   企鹅情绪表不写（取 neutral 基线值）且企鹅模型不消费，互不干扰。
 *
 * 模型选择（临时实现）：localStorage 键 `pet-model-3d` 可覆盖，默认 `'rabbit'`。
 * **将来由"角色系统"统一管理模型/角色选择（含 UI 与角色档案），见设计文档 §4.6**；
 * 当前 localStorage 只是过渡方案（与渲染器 kind 的 `pet-renderer` 覆盖同款思路）。
 */
import type * as THREE from 'three'
import type { PetFrame3D } from './animator'
import type { Emotion } from '../../../../shared/protocol'
import type { PetPose3D } from './emotion-map'

export interface Vec3 {
  x: number
  y: number
  z: number
}

/** 椭球部件（几何用单位球，按 scale 缩放；圆钝轮廓的唯一来源） */
export interface Ellipsoid {
  /** 中心（相对所在组原点） */
  center: Vec3
  /** 三轴半径 */
  scale: Vec3
  /** 附加欧拉旋转（弧度，可选） */
  rotX?: number
  rotZ?: number
}

/**
 * 通用彩色表面材质：toy = MeshStandardMaterial（软胶玩具）、toon = MeshToonMaterial（卡通分带）、
 * fluffy = MeshPhysicalMaterial（毛绒 sheen）——applyFrame 只依赖 color/opacity，各风格通用。
 */
export type PetSurfaceMaterial3D = THREE.MeshStandardMaterial | THREE.MeshToonMaterial | THREE.MeshPhysicalMaterial

// ------------------------------------------------------------------ 模型选择

/** 3D 模型标识（新增模型：models/ 下建文件 + 注册 + 这里加 id） */
export type PetModelId = 'penguin' | 'rabbit'

/**
 * 行走风格（animator 按此切换走路合成）：
 * - `'waddle'`：企鹅摇摆小碎步（固定周期）；
 * - `'hop'`：v2 兔子蹦跳（固定周期；保留备用）；
 * - `'human'`：**v3 拟人步态**——双腿交替迈步 + 反相摆臂 + 身体起伏/侧倾，
 *   步频 = 窗口实际移动速度 / 步幅（`setLocomotionSpeed` 喂入，节奏与窗口移动匹配）。
 */
export type WalkStyle3D = 'waddle' | 'hop' | 'human'

/**
 * 渲染风格（渲染器按此装配光照；材质由模型自选，见各模型 build）：
 * - `'toy'`：写实软胶玩具光影（暖主光 + 冷补光 + 半球环境光）——企鹅沿用；
 * - `'toon'`：卡通平光（环境光为主、方向光弱化，配合 MeshToonMaterial 分带 + 描边）——v2 兔子（保留）；
 * - `'fluffy'`：**soft 3D 毛绒感**（MeshPhysicalMaterial + sheen + 浅色绒毛边缘壳，
 *   大面积柔和漫射光、低对比、无描边——v3 兔子，3D 毛绒渲染风的原型）。
 */
export type RenderStyle3D = 'toy' | 'toon' | 'fluffy'

/** 缺省模型（用户 2026-10-14 决策：兔子上线后默认兔子） */
export const DEFAULT_PET_MODEL_ID: PetModelId = 'rabbit'

/** localStorage 覆盖键（非法值忽略；将来由角色系统接管，见本文件顶部注释） */
export const PET_MODEL_STORAGE_KEY = 'pet-model-3d'

const VALID_MODEL_IDS: ReadonlySet<string> = new Set(['penguin', 'rabbit'])

/** 解析当前应使用的模型：localStorage 覆盖 → 缺省 'rabbit' */
export function resolvePetModelId(): PetModelId {
  try {
    const override = window.localStorage.getItem(PET_MODEL_STORAGE_KEY)
    if (override && VALID_MODEL_IDS.has(override)) return override as PetModelId
  } catch {
    /* localStorage 不可用（隐私模式等）：走缺省 */
  }
  return DEFAULT_PET_MODEL_ID
}

// ------------------------------------------------------------------ 部件句柄（超集）

/**
 * 单只眼睛的部件句柄（眼睛组原点 = 眼中心；左右眼坐标对称、无镜像组）。
 * 语义为通用抽象：`white` = 外圈底色层（企鹅 = 眼白、兔子 = 深色眼圈），
 * `pupil` = 可动瞳孔层（瞳孔 + 高光随此层注视偏移），`arc/brow` = 眯眼笑弧与眉毛。
 */
export interface EyeParts3D {
  /** 外层：定位（+ 可选的左右轻旋） */
  group: THREE.Group
  /** 圆眼组（scale.y 做眨眼/眯眼） */
  round: THREE.Group
  /** 瞳孔组（平移注视 + 缩放） */
  pupil: THREE.Group
  /** 笑眼弧线（∩ 半圆环；opacity 驱动显隐） */
  arc: THREE.Mesh
  /** 眉毛组（rotation.z 倾角 + position.y 提升） */
  brow: THREE.Group
  /** 圆眼组的共享材质（底色/瞳孔/高光；opacity 驱动淡入淡出） */
  roundMaterials: { white: PetSurfaceMaterial3D; pupil: PetSurfaceMaterial3D; highlight: THREE.MeshBasicMaterial }
  arcMaterial: PetSurfaceMaterial3D
  browMaterial: PetSurfaceMaterial3D
  /** 眉绘制参数（相对眼球中心；由模型 config 提供） */
  browParams: {
    /** 眉静息高度（相对眼球中心） */
    baseY: number
    /** 怒眉倾角（弧度；左眉内端下压），悲眉取反并上移 */
    angryAngle: number
    /** 悲眉整体上移量 */
    sadLift: number
  }
}

/** 嘴句柄（上片俯仰 + 下片开合；两模型同构：企鹅上下喙 / 兔子上下唇） */
export interface MouthParts3D {
  /** 上片组（rotation.x = upperRest + beakLift） */
  upper: THREE.Group
  /** 下片组（轴心 = 根部；rotation.x = lowerRest + mouthOpen × maxOpenAngle） */
  lower: THREE.Group
  /** 上片静息俯仰（弧度） */
  upperRest: number
  /** 下片静息俯仰（弧度） */
  lowerRest: number
  /** 口型全开时下片绕根部下旋最大角度（弧度） */
  maxOpenAngle: number
}

/** 心形粒子锚点（世界坐标 + 起飞延迟 + 左右摆幅） */
export interface HeartAnchor3D {
  pos: Vec3
  delayMs: number
  sway: number
}

/**
 * 模型共用部件句柄（渲染器 applyFrame 唯一依赖的结构）。
 * 模型专属句柄（呆毛/翅膀/耳朵/尾巴/手臂）留在各模型自己的 Parts 接口里，
 * 由该模型的 applyExtras 闭包消费。
 */
export interface PetParts3D {
  /** 场景根（mount/unmount 时增删的就是它） */
  group: THREE.Group
  /** 呼吸/弹跳（绕脚底） */
  root: THREE.Group
  /** 身体倾斜组 */
  tilt: THREE.Group
  /** 头组（原点 = 头中心；rotation 为相对身体的头部姿态） */
  head: THREE.Group
  eyeL: EyeParts3D
  eyeR: EyeParts3D
  /** 瞳孔相对眼白中心的 +z 前移（applyFrame 逐帧写瞳孔位置用） */
  eyePupilForward: number
  mouth: MouthParts3D
  blushL: THREE.Mesh
  blushR: THREE.Mesh
  blushMaterial: PetSurfaceMaterial3D
  /** 腮红最大不透明度（animator 输出 0–1 强度 → applyFrame 乘此值写材质） */
  blushMaxOpacity: number
  /** 心形粒子（各自独立材质以支持错开淡出） */
  hearts: THREE.Mesh[]
  heartMaterials: PetSurfaceMaterial3D[]
  /** 心形粒子锚点（animator 计算飘出轨迹、applyFrame 定位，共用同一数组） */
  heartAnchors: HeartAnchor3D[]
  /** 身体材质（情绪色偏：color 在基色 ↔ tint 之间插值） */
  bodyMaterial: PetSurfaceMaterial3D
  /** 身体基色（色偏插值基准；模型 config 提供） */
  bodyBaseColor: string
  /** 释放全部几何与材质（dispose 时调用） */
  dispose(): void
}

/** 模型 build() 的返回：共用句柄 + 模型专属逐帧写入闭包 */
export interface PetBuildResult3D {
  parts: PetParts3D
  /**
   * 模型专属逐帧写入（通用 applyFrame 之后调用一次）。
   * 闭包捕获具体句柄（类型安全）；帧数据里本模型不消费的字段直接忽略。
   */
  applyExtras(frame: PetFrame3D): void
}

// ------------------------------------------------------------------ 模型度量（animator 用）

/**
 * 模型提供给 animator 的数值度量（与几何句柄分离：animator 只算数不碰场景，
 * 需要的造型数值从这里取）。相机参数也放这里，供渲染器外壳构图。
 */
export interface PetModelMetrics3D {
  /** 相机与构图（保证模型 + 动画余量在 208×208 容器内） */
  camera: {
    /** 透视视场角（度）；数值小 → 透视弱、更"平面可爱" */
    fov: number
    /** 相机位置（世界坐标） */
    position: Vec3
    /** 视线目标点 */
    lookAt: Vec3
    /** 窗口尺寸失效（0 宽）时的兜底边长（px） */
    fallbackSize: number
  }
  /** 瞳孔注视最大偏移（世界单位；lookX/lookY = ±1 时） */
  eyeLookRange: { x: number; y: number }
  /** 心形粒子锚点（与 parts.heartAnchors 同一份数据） */
  heartAnchors: HeartAnchor3D[]
}

// ------------------------------------------------------------------ 模型对象

/**
 * 一个 3D 模型 = 造型度量 + 情绪姿态表 + 建模/专属写入。
 * 新增模型：models/ 下新建文件（造型参数内联）→ 实现本接口 → 在 models/index.ts 注册。
 */
export interface PetModel3D {
  id: PetModelId
  /** 日志/调试用中文名 */
  label: string
  /** 走路风格（animator 据此切换走路合成） */
  walkStyle: WalkStyle3D
  /** 渲染风格（渲染器据此装配光照：toy = 玩具光影 / toon = 卡通平光） */
  style: RenderStyle3D
  metrics: PetModelMetrics3D
  /** 情绪 → 部件目标姿态表（模型自带；超集字段缺失即取 neutral 基线/忽略） */
  poses: Record<Emotion, PetPose3D>
  build(): PetBuildResult3D
}
