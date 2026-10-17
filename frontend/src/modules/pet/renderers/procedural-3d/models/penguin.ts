/**
 * 企鹅「小豆」3D 模型：造型参数 + Three.js 程序化建模 + 专属逐帧写入。
 *
 * 本文件是企鹅造型的**唯一事实来源**（与 2D 版 part-animation/config.ts 同一纪律）。
 * 设计准则（用户 2026-10-14 决策）：**可爱优先**。
 * - 幼态比例（chibi）：大头（头直径 ≈ 总体高 48%）+ 圆胖矮短身体；
 * - 大眼睛：眼白球 + 大瞳孔 + 明显高光点（眨眼/眯眼笑是主要表情语言）；
 * - 全部圆钝化：翅膀 = 小肉翅（压扁椭球）、脚 = 圆球、喙 = 圆钝短椭球，
 *   心形粒子底部亦做圆弧收口——**任何部件不允许尖锐感**；
 * - 配色柔和偏暖偏软（光照叠加后偏高光的"软胶玩具"感）。
 *
 * 层级结构（含动画轴心）：
 *   group（根，挂在场景）
 *   └ root（呼吸缩放 squash & stretch + 弹跳位移；原点 = 脚底，缩放绕脚底）
 *      └ tilt（身体倾斜 rotation.z，绕脚底轴心）
 *         ├ 脚×2 / 小肉翅×2（根部轴心）/ 身体 / 肚子
 *         └ head（头组，原点 = 头中心：头动画 = 相对身体的旋转）
 *            ├ 头球 / 眼×2（圆眼组 + 笑眼弧 + 眉）/ 上下喙 / 腮红×2 / 呆毛（根部轴心）
 *
 * 坐标系（世界坐标，Y 向上）：
 * - 原点在地面（脚底），企鹅正面朝 +Z（相机从 +Z 看）；
 * - 除"头部部件组"外，坐标均为世界坐标；
 * - 头部部件（headParts）用**相对头中心**的局部坐标（头组挂载在头中心）。
 *
 * 多模型架构（2026-10-14）：通用部件（根/头/眼/嘴/腮红/心形粒子）填进 PetParts3D
 * 由渲染器 applyFrame 驱动；企鹅专属件（呆毛/肉翅）在 build 返回的 applyExtras
 * 闭包里驱动——帧数据里的兔耳/尾巴字段企鹅直接忽略（不消费）。
 *
 * 调整造型只改本文件；修改后建议用离屏预览（见 docs/报告/前端/three-d-rabbit-report.md）核对观感。
 */
import * as THREE from 'three'
import type {
  Ellipsoid,
  EyeParts3D,
  HeartAnchor3D,
  PetBuildResult3D,
  PetModel3D,
  PetModelMetrics3D,
  PetParts3D,
  Vec3
} from '../config'
import { EMOTION_POSES } from '../emotion-map'
import { buildHeartGeometry, buildHearts, createResourceTracker, ellipsoid, eyeMaterials, softMaterial, v3 } from './geometry'

export interface Penguin3DConfig {
  /** 相机与构图（保证企鹅 + 动画余量在 208×208 容器内） */
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

  /** 身体：球体压扁拉长的椭球，底部 0.03（脚下方留一点接地感） */
  body: Ellipsoid
  /** 肚子：白色前襟椭球（前表面突出身体，露出白肚） */
  belly: Ellipsoid

  /** 头：大球（chibi 大脑袋）；neckY 为 headGroup 挂点（= 头中心） */
  head: { radius: number; centerY: number }

  /** 头部部件（局部坐标 = 世界坐标 − head.centerY；挂载随头摆动） */
  headParts: {
    /** 眼睛（左右镜像；pos 为眼球中心） */
    eyes: {
      /** 眼睛中心相对头中心（x = ±dx） */
      pos: { x: number; y: number; z: number }
      /** 眼白球半径 */
      whiteRadius: number
      /** 瞳孔球半径（大瞳孔：半径比 ≈ 0.65，可爱核心） */
      pupilRadius: number
      /** 瞳孔相对眼白中心的 +z 前移 */
      pupilForward: number
      /** 高光球半径（明显高光点，双眼各一） */
      highlightRadius: number
      /** 高光相对瞳孔中心的偏移（左上） */
      highlightOffset: Vec3
      /** 瞳孔注视最大偏移（lookX/lookY=±1 时，世界单位） */
      lookRange: { x: number; y: number }
      /**
       * 眯眼笑弧线（∩ 半圆环）：**相对眼球中心**定位
       * （实现挂在眼睛组内，随目光不随眉；z 取"贴头面之外"的值）
       */
      arc: { radius: number; tube: number; z: number; yOffset: number }
      /**
       * 表情眉毛（圆头胶囊，无锐角；仅 angry/sad 显示）：**相对眼球中心**定位
       * （pos.x 为相对眼中心的水平微调：负值 = 略靠内）
       */
      brow: {
        pos: { x: number; y: number; z: number }
        /** 胶囊长度（含两端圆头；横放） */
        length: number
        /** 胶囊截面半径 */
        radius: number
        /** 怒眉倾角（弧度；左眉负值 = 内端下压），悲眉取反并整体上移 */
        angryAngle: number
        /** 悲眉整体上移量 */
        sadLift: number
      }
    }

    /** 喙（上喙 + 下喙分件；圆钝短椭球，"小豆嘴"） */
    beak: {
      /** 上喙：中心（局部坐标）+ 三轴半径 + 上翘角（rotation.x，负 = 前端上翘） */
      upper: { center: Vec3; scale: Vec3; rotX: number }
      /** 下喙：pivot 为绕之开合旋转的根点；offset 为几何中心相对 pivot */
      lower: { pivot: Vec3; offset: Vec3; scale: Vec3; rotX: number }
      /** 口型全开时下喙绕 pivot 下旋最大角度（弧度） */
      maxOpenAngle: number
    }

    /** 腮红：脸侧柔粉半透明压扁椭球 */
    blush: { center: Vec3; scale: Vec3; color: string; maxOpacity: number }

    /** 呆毛：细圆锥（上细下粗）+ 圆头小球；root 为摆动轴心 */
    hair: {
      root: Vec3
      /** 锥体高度 */
      height: number
      /** 底部半径 / 顶部半径 */
      radiusBottom: number
      radiusTop: number
      /** 顶部圆头小球半径（吃掉锥顶尖角 → 圆钝） */
      tipRadius: number
      /** 静息前倾角（rotation.x，负 = 向前） */
      leanX: number
    }
  }

  /** 小肉翅（短小圆钝；root 为肩部旋转轴心，几何中心 = root + offset） */
  wings: {
    left: { root: Vec3; offset: Vec3; scale: Vec3; restRotZ: number }
    right: { root: Vec3; offset: Vec3; scale: Vec3; restRotZ: number }
  }

  /** 圆球脚（可爱优先：不用扁脚掌） */
  feet: {
    left: { center: Vec3; radius: number; scale: Vec3 }
    right: { center: Vec3; radius: number; scale: Vec3 }
  }

  /** 摸头反应的心形粒子（圆钝心形挤出体；锚点在头顶上方世界坐标） */
  hearts: {
    /** 心形尺寸（宽，世界单位） */
    size: number
    /** 粒子：锚点 + 起飞延迟 + 左右摆幅 */
    anchors: HeartAnchor3D[]
  }

  /** 配色（柔和偏暖；光照会整体提亮，取值比 2D 版略柔） */
  colors: {
    body: string
    belly: string
    wing: string
    hair: string
    eyeWhite: string
    pupil: string
    highlight: string
    arc: string
    brow: string
    beak: string
    beakLower: string
    foot: string
    blush: string
    heart: string
  }
}

export const PENGUIN_3D_CONFIG: Penguin3DConfig = {
  camera: {
    fov: 30,
    position: { x: 0, y: 1.15, z: 4.95 },
    lookAt: { x: 0, y: 1.02, z: 0 },
    fallbackSize: 208
  },

  // 身体：圆胖矮短（高 1.04、宽 0.96、厚 0.92）；顶部 1.07 与头底 0.98 相交融合
  body: { center: { x: 0, y: 0.55, z: 0 }, scale: { x: 0.48, y: 0.52, z: 0.46 } },
  // 肚子：白色前襟，向前突出 0.03 露出白肚
  belly: { center: { x: 0, y: 0.50, z: 0.17 }, scale: { x: 0.30, y: 0.36, z: 0.32 } },

  // 头：直径 0.92 ≈ 总高 1.90 的 48%（chibi 大脑袋）
  head: { radius: 0.46, centerY: 1.44 },

  headParts: {
    // 眼睛：大眼球（直径 0.24；两眼中心距 0.34，占头宽 63%）
    eyes: {
      pos: { x: 0.17, y: 0.1, z: 0.395 },
      whiteRadius: 0.12,
      pupilRadius: 0.078,
      pupilForward: 0.048,
      highlightRadius: 0.03,
      highlightOffset: { x: -0.03, y: 0.032, z: 0.06 },
      lookRange: { x: 0.05, y: 0.042 },
      // 眯眼笑弧线：相对眼球中心；中心略低于眼中心（像闭上的眼睑），贴头面之外
      arc: { radius: 0.105, tube: 0.013, z: 0.075, yOffset: -0.02 },
      brow: {
        // 相对眼球中心：略靠内、眼睛上方 0.115、贴头面之外（z 微前）
        pos: { x: -0.015, y: 0.115, z: 0.02 },
        length: 0.105,
        radius: 0.018,
        angryAngle: 0.42,
        sadLift: 0.05
      }
    },

    // 喙：扁宽圆钝的"小鸭嘴"（上喙椭球 + 下喙椭球）；下喙闭口时完全藏于上喙之后，
    // 张口（口型/哈欠）才绕根部下旋露出（见 maxOpenAngle）
    beak: {
      upper: {
        center: { x: 0, y: -0.11, z: 0.40 },
        scale: { x: 0.105, y: 0.062, z: 0.17 },
        rotX: -0.14
      },
      lower: {
        pivot: { x: 0, y: -0.115, z: 0.30 },
        offset: { x: 0, y: 0.008, z: 0.09 },
        scale: { x: 0.082, y: 0.042, z: 0.145 },
        rotX: 0.06
      },
      maxOpenAngle: 0.45
    },

    // 腮红：柔粉半透明（贴脸侧，与喙同高附近）
    blush: {
      center: { x: 0.285, y: -0.14, z: 0.335 },
      scale: { x: 0.105, y: 0.065, z: 0.08 },
      color: '#FFADC2',
      maxOpacity: 0.88
    },

    // 呆毛：头顶一根短粗小芽（锥 + 大圆头吃尖角），前倾弯弯（萌点）
    hair: {
      root: { x: 0, y: 0.42, z: -0.02 },
      height: 0.22,
      radiusBottom: 0.055,
      radiusTop: 0.02,
      tipRadius: 0.04,
      leanX: -0.38
    }
  },

  // 小肉翅：短小（长 0.5）圆钝压扁椭球，肩部轴心贴身体上侧
  wings: {
    left: {
      root: { x: -0.33, y: 0.95, z: 0 },
      offset: { x: -0.10, y: -0.18, z: 0 },
      scale: { x: 0.058, y: 0.25, z: 0.15 },
      restRotZ: -0.22
    },
    right: {
      root: { x: 0.33, y: 0.95, z: 0 },
      offset: { x: 0.10, y: -0.18, z: 0 },
      scale: { x: 0.058, y: 0.25, z: 0.15 },
      restRotZ: 0.22
    }
  },

  // 脚：圆球（微前伸，露出更多）
  feet: {
    left: { center: { x: -0.20, y: 0.14, z: 0.09 }, radius: 0.14, scale: { x: 1.05, y: 1.0, z: 1.25 } },
    right: { center: { x: 0.20, y: 0.14, z: 0.09 }, radius: 0.14, scale: { x: 1.05, y: 1.0, z: 1.25 } }
  },

  hearts: {
    size: 0.20,
    anchors: [
      { pos: { x: -0.20, y: 1.88, z: 0.12 }, delayMs: 0, sway: 0.10 },
      { pos: { x: 0.22, y: 1.95, z: 0.10 }, delayMs: 240, sway: -0.11 }
    ]
  },

  colors: {
    body: '#5A639B', // 柔和深蓝紫（比 2D 版亮一点，光照下更软）
    belly: '#FBF6EE', // 奶白（偏暖）
    wing: '#4F5A8A',
    hair: '#535E8E',
    eyeWhite: '#FFFFFF',
    pupil: '#2B3049',
    highlight: '#FFFFFF',
    arc: '#2B3049',
    brow: '#39405E',
    beak: '#F6A93B', // 暖橙
    beakLower: '#E8962A', // 下喙稍深（张口时露出内色）
    foot: '#F6AE4A',
    blush: '#FF9FB2',
    heart: '#FF8FA8'
  }
}

// ------------------------------------------------------------------ 建模

/** 企鹅专属句柄（呆毛/肉翅；通用句柄见 PetParts3D） */
export interface PenguinParts3D extends PetParts3D {
  /** 呆毛组（轴心 = 根部） */
  hair: THREE.Group
  wingL: THREE.Group
  wingR: THREE.Group
}

/**
 * 构建企鹅 3D 部件（所有几何/材质登记在 dispose 中，保证彻底释放）。
 * 返回通用句柄 + applyExtras（呆毛/肉翅的逐帧写入闭包）。
 */
export function buildPenguin3D(cfg: Penguin3DConfig = PENGUIN_3D_CONFIG): PetBuildResult3D {
  const tracker = createResourceTracker()
  const { trackG, trackM } = tracker
  const C = cfg.colors

  // ---------------- 材质（软胶玩具：适度粗糙 + 轻微高光） ----------------
  const matBody = softMaterial(trackM, C.body)
  const matBelly = softMaterial(trackM, C.belly, 0.55, 0.0)
  const matWing = softMaterial(trackM, C.wing)
  const matHair = softMaterial(trackM, C.hair, 0.6)
  const matBeak = softMaterial(trackM, C.beak, 0.5, 0.0)
  const matBeakLower = softMaterial(trackM, C.beakLower, 0.5, 0.0)
  const matFoot = softMaterial(trackM, C.foot, 0.5, 0.0)
  const eyeM = eyeMaterials(trackM, C)
  const matBlush = trackM(
    new THREE.MeshStandardMaterial({
      color: C.blush,
      roughness: 0.85,
      metalness: 0.0,
      transparent: true,
      depthWrite: false,
      opacity: 0
    })
  )

  // ---------------- 共享几何（全部圆钝） ----------------
  const geoSphere = trackG(new THREE.SphereGeometry(1, 40, 28)) // 单位球：身体/头/椭球通用
  const geoSphereSmall = trackG(new THREE.SphereGeometry(1, 24, 18)) // 小件（眼/脚/高光）
  const geoUpperBeak = trackG(new THREE.SphereGeometry(1, 32, 22))
  const geoLowerBeak = trackG(new THREE.SphereGeometry(1, 28, 20))
  const geoCone = trackG(
    new THREE.CylinderGeometry(cfg.headParts.hair.radiusTop, cfg.headParts.hair.radiusBottom, cfg.headParts.hair.height, 12)
  )
  const geoArc = trackG(new THREE.TorusGeometry(cfg.headParts.eyes.arc.radius, cfg.headParts.eyes.arc.tube, 10, 24, Math.PI))
  const geoBrow = trackG(new THREE.CapsuleGeometry(cfg.headParts.eyes.brow.radius, cfg.headParts.eyes.brow.length, 6, 12))

  // ---------------- 层级 ----------------
  const group = new THREE.Group()
  const root = new THREE.Group()
  const tilt = new THREE.Group()
  group.add(root)
  root.add(tilt)

  // ---- 脚（圆球） ----
  const buildFoot = (f: Penguin3DConfig['feet']['left']): THREE.Mesh => {
    const m = new THREE.Mesh(geoSphereSmall, matFoot)
    m.position.copy(v3(f.center))
    m.scale.setScalar(f.radius).multiply(v3(f.scale))
    return m
  }
  tilt.add(buildFoot(cfg.feet.left), buildFoot(cfg.feet.right))

  // ---- 小肉翅（肩部轴心组 + 椭球） ----
  const buildWing = (w: Penguin3DConfig['wings']['left']): THREE.Group => {
    const g = new THREE.Group()
    g.position.copy(v3(w.root))
    g.rotation.z = w.restRotZ
    const m = new THREE.Mesh(geoSphere, matWing)
    m.position.copy(v3(w.offset))
    m.scale.copy(v3(w.scale))
    g.add(m)
    return g
  }
  const wingL = buildWing(cfg.wings.left)
  const wingR = buildWing(cfg.wings.right)
  tilt.add(wingL, wingR)

  // ---- 身体 + 肚子 ----
  const body = ellipsoid(geoSphere, matBody, cfg.body)
  const belly = ellipsoid(geoSphere, matBelly, cfg.belly)
  tilt.add(body, belly)

  // ---- 头组（原点 = 头中心） ----
  const head = new THREE.Group()
  head.position.y = cfg.head.centerY
  tilt.add(head)

  const headBall = new THREE.Mesh(geoSphere, matBody) // 头与身体同材质（色偏一体）
  headBall.scale.setScalar(cfg.head.radius)
  head.add(headBall)

  // 眼睛（左 = x 负侧；两眼结构一致，无镜像组）
  const buildEye = (xSign: number): EyeParts3D => {
    const e = cfg.headParts.eyes
    const g = new THREE.Group()
    g.position.set(xSign * e.pos.x, e.pos.y, e.pos.z)

    const round = new THREE.Group()
    const white = new THREE.Mesh(geoSphereSmall, eyeM.white)
    white.scale.setScalar(e.whiteRadius)
    round.add(white)

    const pupil = new THREE.Group()
    pupil.position.z = e.pupilForward
    const pupilMesh = new THREE.Mesh(geoSphereSmall, eyeM.pupil)
    pupilMesh.scale.setScalar(e.pupilRadius)
    pupil.add(pupilMesh)
    const highlight = new THREE.Mesh(geoSphereSmall, eyeM.highlight)
    highlight.position.copy(v3(e.highlightOffset))
    highlight.scale.setScalar(e.highlightRadius)
    pupil.add(highlight)
    round.add(pupil)

    const arc = new THREE.Mesh(geoArc, eyeM.arc)
    arc.position.set(0, e.arc.yOffset, e.arc.z)
    // 外端微微下垂（左右对称），更像"眯眼笑"的小月牙
    arc.rotation.z = xSign * -0.10
    arc.visible = false

    const brow = new THREE.Group()
    brow.position.set(xSign * e.brow.pos.x, e.brow.pos.y, e.brow.pos.z)
    const browMesh = new THREE.Mesh(geoBrow, eyeM.brow)
    browMesh.rotation.z = Math.PI / 2 // 胶囊横放
    brow.add(browMesh)
    brow.visible = false

    g.add(round, arc, brow)
    return {
      group: g,
      round,
      pupil,
      arc,
      brow,
      roundMaterials: { white: eyeM.white, pupil: eyeM.pupil, highlight: eyeM.highlight },
      arcMaterial: eyeM.arc,
      browMaterial: eyeM.brow,
      browParams: { baseY: e.brow.pos.y, angryAngle: e.brow.angryAngle, sadLift: e.brow.sadLift }
    }
  }
  const eyeL = buildEye(-1)
  const eyeR = buildEye(1)
  head.add(eyeL.group, eyeR.group)

  // 喙：上喙（圆钝椭球，微翘）+ 下喙（绕根部开合）
  const beakUpper = new THREE.Group()
  beakUpper.position.copy(v3(cfg.headParts.beak.upper.center))
  beakUpper.rotation.x = cfg.headParts.beak.upper.rotX
  const beakUpperMesh = new THREE.Mesh(geoUpperBeak, matBeak)
  beakUpperMesh.scale.copy(v3(cfg.headParts.beak.upper.scale))
  beakUpper.add(beakUpperMesh)

  const beakLower = new THREE.Group()
  beakLower.position.copy(v3(cfg.headParts.beak.lower.pivot))
  beakLower.rotation.x = cfg.headParts.beak.lower.rotX
  const beakLowerMesh = new THREE.Mesh(geoLowerBeak, matBeakLower)
  beakLowerMesh.position.copy(v3(cfg.headParts.beak.lower.offset))
  beakLowerMesh.scale.copy(v3(cfg.headParts.beak.lower.scale))
  beakLower.add(beakLowerMesh)
  head.add(beakUpper, beakLower)

  // 腮红（左右镜像；柔粉半透明，opacity 由 animator 驱动）
  const buildBlush = (xSign: number): THREE.Mesh => {
    const bl = cfg.headParts.blush
    const m = new THREE.Mesh(geoSphereSmall, matBlush)
    m.position.copy(v3(bl.center))
    m.position.x *= xSign
    m.scale.copy(v3(bl.scale))
    return m
  }
  const blushL = buildBlush(-1)
  const blushR = buildBlush(1)
  head.add(blushL, blushR)

  // 呆毛（细锥 + 圆头小球；轴心 = 根部）
  const hair = new THREE.Group()
  hair.position.copy(v3(cfg.headParts.hair.root))
  hair.rotation.x = cfg.headParts.hair.leanX
  const hairCone = new THREE.Mesh(geoCone, matHair)
  hairCone.position.y = cfg.headParts.hair.height / 2
  const hairTip = new THREE.Mesh(geoSphereSmall, matHair)
  hairTip.position.y = cfg.headParts.hair.height
  hairTip.scale.setScalar(cfg.headParts.hair.tipRadius)
  hair.add(hairCone, hairTip)
  head.add(hair)

  // ---- 心形粒子（各自材质：错开淡出） ----
  const geoHeart = trackG(buildHeartGeometry(cfg.hearts.size))
  const { hearts, heartMaterials } = buildHearts(trackM, geoHeart, cfg.hearts.anchors, C.heart, group)

  const parts: PenguinParts3D = {
    group,
    root,
    tilt,
    head,
    eyeL,
    eyeR,
    eyePupilForward: cfg.headParts.eyes.pupilForward,
    mouth: {
      upper: beakUpper,
      lower: beakLower,
      upperRest: cfg.headParts.beak.upper.rotX,
      lowerRest: cfg.headParts.beak.lower.rotX,
      maxOpenAngle: cfg.headParts.beak.maxOpenAngle
    },
    blushL,
    blushR,
    blushMaterial: matBlush,
    blushMaxOpacity: cfg.headParts.blush.maxOpacity,
    hearts,
    heartMaterials,
    heartAnchors: cfg.hearts.anchors,
    bodyMaterial: matBody,
    bodyBaseColor: C.body,
    hair,
    wingL,
    wingR,
    dispose(): void {
      tracker.disposeAll()
    }
  }

  return {
    parts,
    /** 企鹅专属逐帧：呆毛弯曲 + 肉翅展开/前后摆（兔耳/尾巴字段企鹅不消费，忽略） */
    applyExtras(frame): void {
      // 呆毛：静息前倾 + 情绪弯曲（摆动在 animator 里已合入 hairBend）
      hair.rotation.x = cfg.headParts.hair.leanX + frame.hairBend
      // 小肉翅：展开角（左翅负向展开、右翅镜像）+ 走路前后摆
      wingL.rotation.z = cfg.wings.left.restRotZ + frame.wingAngle
      wingL.rotation.x = frame.wingSwing
      wingR.rotation.z = cfg.wings.right.restRotZ - frame.wingAngle
      wingR.rotation.x = frame.wingSwing
    }
  }
}

/** animator 需要的度量：相机 + 注视范围 + 心形锚点 */
export const PENGUIN_3D_METRICS: PetModelMetrics3D = {
  camera: PENGUIN_3D_CONFIG.camera,
  eyeLookRange: {
    x: PENGUIN_3D_CONFIG.headParts.eyes.lookRange.x,
    y: PENGUIN_3D_CONFIG.headParts.eyes.lookRange.y
  },
  heartAnchors: PENGUIN_3D_CONFIG.hearts.anchors
}

/** 模型对象（注册表 models/index.ts 使用） */
export const PENGUIN_3D_MODEL: PetModel3D = {
  id: 'penguin',
  label: '企鹅「小豆」3D',
  walkStyle: 'waddle',
  style: 'toy', // 软胶玩具光影（保持既有观感不变）
  metrics: PENGUIN_3D_METRICS,
  poses: EMOTION_POSES,
  build: () => buildPenguin3D(PENGUIN_3D_CONFIG)
}
